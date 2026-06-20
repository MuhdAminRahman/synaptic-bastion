const fs = require('fs');
const path = require('path');

const PORT = 9000;
const AUTH_TOKEN = '<AUTH_TOKEN_HERE>';
const NODES_FILE = path.join(__dirname, 'nodes.json');
const JOBS_DIR = path.join(__dirname, 'provision-jobs');
const KEY_PATH = '/root/.ssh/ha_key';
const KEY_PUB_PATH = '/root/.ssh/ha_key.pub';
const OUTPOSTS_FILE = path.join(__dirname, 'outposts.json');

// Ensure jobs dir exists
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

module.exports = {
  PORT, AUTH_TOKEN, NODES_FILE, JOBS_DIR, KEY_PATH, KEY_PUB_PATH, OUTPOSTS_FILE,
};
