const express = require('express');
const { getAppCpp } = require('../lib/templates');

module.exports = function(app) {
  app.get('/api/app-template', (req, res) => {
    const name = req.query.name || 'node';
    const port = parseInt(req.query.port) || 8080;
    const dbHost = req.query.dbHost || 'localhost';
    const dbPass = req.query.dbPass || 'secure-password-here';
    res.type('text/plain').send(getAppCpp(name, port, dbHost, dbPass));
  });

};
