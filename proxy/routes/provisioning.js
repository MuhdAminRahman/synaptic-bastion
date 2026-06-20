const express = require('express');
const crypto = require('crypto');
const { loadJob, runProvision, saveJob } = require('../lib/provisioning');

module.exports = function(app) {
  app.post('/api/provision', (req, res) => {
    const id = crypto.randomBytes(8).toString('hex');
    const job = { id, nodeData: req.body, status: 'running', steps: [], startedAt: Date.now() };
    saveJob(id, job);
    runProvision(id);
    res.json({ jobId: id, status: 'started' });
  });


  app.get('/api/provision/:jobId', (req, res) => {
    const job = loadJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

};
