function getAppCpp(serverName, port, dbHost='localhost', dbPass='secure-password-here') {
  return `#include <iostream>
#include <string>
#include <cstring>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <thread>
#include <vector>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <functional>
#include <csignal>
#include <atomic>
#include <pqxx/pqxx>

const int PORT = ${port || 8080};
const int THREAD_POOL_SIZE = 8;
static std::atomic<bool> running{true};
static int server_fd = -1;

// Item 7: Thread pool
class ThreadPool {
  std::vector<std::thread> workers;
  std::queue<std::function<void()>> tasks;
  std::mutex mtx;
  std::condition_variable cv;
  bool stop = false;
public:
  ThreadPool(size_t n) {
    for (size_t i=0;i<n;i++) workers.emplace_back([this]{
      while(true) {
        std::function<void()> task;
        { std::unique_lock<std::mutex> lk(mtx);
          cv.wait(lk,[this]{return stop||!tasks.empty();});
          if(stop && tasks.empty()) return;
          task = std::move(tasks.front()); tasks.pop(); }
        task();
      }
    });
  }
  void enqueue(std::function<void()> f) {
    { std::lock_guard<std::mutex> lk(mtx); tasks.push(std::move(f)); }
    cv.notify_one();
  }
  ~ThreadPool() {
    { std::lock_guard<std::mutex> lk(mtx); stop=true; }
    cv.notify_all();
    for(auto& w:workers) w.join();
  }
};

// Item 6: Persistent DB connection with reconnect
class DBConn {
  std::string connstr;
  std::unique_ptr<pqxx::connection> conn;
  std::mutex mtx;
public:
  DBConn(const std::string& cs): connstr(cs) {}
  std::string query(const std::string& sql) {
    std::lock_guard<std::mutex> lk(mtx);
    // Try existing connection, reconnect on any failure
    for (int attempt = 0; attempt < 2; attempt++) {
      try {
        if (!conn || !conn->is_open()) {
          conn = std::make_unique<pqxx::connection>(connstr);
        }
        pqxx::work txn(*conn);
        auto res = txn.exec(sql);
        txn.commit();
        return std::string(res[0][0].c_str());
      } catch (const pqxx::broken_connection& e) {
        conn.reset(); // force reconnect next attempt
        if (attempt == 1) throw;
      } catch (...) {
        conn.reset();
        throw;
      }
    }
    throw std::runtime_error("DB query failed after retry");
  }
};

static DBConn* db = nullptr;

std::string handleRequest(const std::string& method, const std::string& path) {
  const std::string cors = "Access-Control-Allow-Origin: *\\r\\nAccess-Control-Allow-Methods: GET, OPTIONS\\r\\n";
  // Item 9: Handle OPTIONS preflight
  if (method == "OPTIONS") {
    return "HTTP/1.1 204 No Content\\r\\n" + cors + "Content-Length: 0\\r\\n\\r\\n";
  }
  if (path == "/health") {
    // Always probe LOCAL postgres — detects if this node's DB is down
    // dbHost may point to master, but health must reflect local state
    std::string localConnstr = "host=localhost dbname=appdb user=appuser password=${dbPass} connect_timeout=3";
    std::string dbStatus = "healthy";
    std::string dbErr = "";
    try {
      pqxx::connection probe(localConnstr);
      pqxx::work txn(probe);
      txn.exec("SELECT 1");
      txn.commit();
    } catch (const std::exception& e) {
      dbStatus = "degraded";
      dbErr = std::string(e.what()).substr(0, 60);
    }
    std::string code = (dbStatus == "healthy") ? "200 OK" : "503 Service Unavailable";
    std::string errField = dbErr.empty() ? "" : ",\\"db_error\\":\\"" + dbErr + "\\"";
    return "HTTP/1.1 " + code + "\\r\\nContent-Type: application/json\\r\\n" + cors + "\\r\\n"
      "{\\"status\\":\\"" + dbStatus + "\\",\\"server\\":\\"${serverName}\\"" +
      ",\\"timestamp\\":\\"" + std::to_string(time(nullptr)) + "\\"" + errField + "}";
  }
  if (path == "/data") {
    try {
      std::string tables = db->query("SELECT COUNT(*) FROM pg_tables");
      return "HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n" + cors + "\\r\\n"
        "{\\"tables\\":\\"" + tables + "\\",\\"server\\":\\"${serverName}\\"}";
    } catch (const std::exception& e) {
      return "HTTP/1.1 500 Internal Server Error\\r\\nContent-Type: text/plain\\r\\n" + cors + "\\r\\nDB Error: " + std::string(e.what());
    }
  }
  return "HTTP/1.1 404 Not Found\\r\\nContent-Type: text/plain\\r\\n" + cors + "\\r\\nNot Found";
}

void handleClient(int fd) {
  // Item 8: Socket receive timeout
  struct timeval tv{5, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

  char buf[4096];
  ssize_t n = recv(fd, buf, sizeof(buf)-1, 0);
  if (n > 0) {
    buf[n] = '\\0';
    std::string req(buf);
    // Item 9: Validate request line
    size_t s1 = req.find(' ');
    size_t s2 = (s1 != std::string::npos) ? req.find(' ', s1+1) : std::string::npos;
    if (s1 == std::string::npos || s2 == std::string::npos) {
      const char* bad = "HTTP/1.1 400 Bad Request\\r\\nContent-Length: 0\\r\\n\\r\\n";
      send(fd, bad, strlen(bad), 0);
    } else {
      std::string method = req.substr(0, s1);
      std::string path = req.substr(s1+1, s2-s1-1);
      // Strip query string
      auto q = path.find('?');
      if (q != std::string::npos) path = path.substr(0, q);
      std::string resp = handleRequest(method, path);
      send(fd, resp.c_str(), resp.length(), 0);
    }
  }
  close(fd);
}

// Item 10: Graceful shutdown
void sigHandler(int) {
  std::cout << "\\nShutting down gracefully..." << std::endl;
  running = false;
  if (server_fd >= 0) close(server_fd);
}

int main() {
  std::string connstr = "host=${dbHost} dbname=appdb user=appuser password=${dbPass}";
  db = new DBConn(connstr);

  signal(SIGTERM, sigHandler);
  signal(SIGINT, sigHandler);

  server_fd = socket(AF_INET, SOCK_STREAM, 0);
  int opt = 1;
  setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

  struct sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = INADDR_ANY;
  addr.sin_port = htons(PORT);
  bind(server_fd, (struct sockaddr*)&addr, sizeof(addr));
  listen(server_fd, 32);

  std::cout << "Server listening on port " << PORT << " (${serverName})" << std::endl;

  ThreadPool pool(THREAD_POOL_SIZE);

  while (running) {
    struct sockaddr_in client{};
    socklen_t len = sizeof(client);
    int fd = accept(server_fd, (struct sockaddr*)&client, &len);
    if (fd >= 0) pool.enqueue([fd]{ handleClient(fd); });
  }

  std::cout << "Server stopped." << std::endl;
  delete db;
  return 0;
}`;
}


function getSystemdService(serverName) {
  return `[Unit]
Description=HA App - ${serverName}
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/ha-app
ExecStart=/opt/ha-app/app
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal
User=root

[Install]
WantedBy=multi-user.target`;
}


function getLaunchctlPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ha-app</string>
  <key>ProgramArguments</key><array><string>/opt/ha-app/app</string></array>
  <key>WorkingDirectory</key><string>/opt/ha-app</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/ha-app.log</string>
  <key>StandardErrorPath</key><string>/tmp/ha-app-error.log</string>
</dict>
</plist>`;
}


function getDockerfile(port) {
  return `FROM ubuntu:22.04
RUN apt-get update && apt-get install -y g++ libpqxx-dev libpq-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app.cpp .
RUN g++ -std=c++17 -O2 app.cpp -lpqxx -lpq -o app
EXPOSE ${port || 8080}
CMD ["./app"]`;
}

// Item 16: Nginx upstream config auto-update

module.exports = { getAppCpp, getSystemdService, getLaunchctlPlist, getDockerfile };
