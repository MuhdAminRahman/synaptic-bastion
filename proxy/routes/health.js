const express = require('express');
const { loadNodes } = require('../lib/nodes-store');

module.exports = function(app) {
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', nodes: Object.keys(loadNodes()), ts: Date.now() });
  });

};
