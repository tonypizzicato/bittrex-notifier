const express = require('express');
const app = express();
const _ = require('lodash');

// IMPORTANT: store is mutable here
module.exports = function(store) {
  app.get('/', (req, res) => res.json(store));

  app.get('/orderssummary', (req, res) => {
    res.json({ activeorderschangepercent: store.orders.reduce((acc, o) => (acc += o.change), 0) });
  });

  app.delete('/banned', (req, res) => res.json(_.set(store, 'banned', {})));
  app.delete('/banned/:market', (req, res) => res.send(_.unset(store, `banned.${req.params.market}`)));
  app.post('/banned/:market', (req, res) => res.send(_.set(store, `banned.${req.params.market}`, req.body)));

  app.post('/pause', (req, res) => {
    store.active = false;

    res.send(store.active);
  });
  app.post('/resume', (req, res) => {
    store.active = true;

    res.send(store.active);
  });

  Object.keys(store).forEach(key => {
    app.get(`/${key}`, (req, res) => res.json(store[key]));
  });

  app.listen(3000, () => console.log('HTTP interface available on port 3000'));
};
