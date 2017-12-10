const express = require('express');
const app = express();
const _ = require('lodash');

// IMPORTANT: store is mutable here
module.exports = function(store) {
  app.get('/', (req, res) => res.json(store));

  app.delete('/banned', (req, res) => res.json(_.set(store, 'banned', {})));
  app.delete('/banned/:market', (req, res) => res.send(_.unset(store, `banned.${req.params.market}`)));

  Object.keys(store).forEach(key => {
    app.get(`/${key}`, (req, res) => res.json(store[key]));
  });

  app.listen(3000, () => console.log('HTTP interface available on port 3000'));
};
