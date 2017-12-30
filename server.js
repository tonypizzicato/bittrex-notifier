const express = require('express');
const app = express();
const _ = require('lodash');

// IMPORTANT: store is mutable here
module.exports = function(store, port, addRoutes = () => void 0) {
  app.get('/', (req, res) => res.json(store));

  app.delete('/banned', (req, res) => res.json(_.set(store, 'banned', {})));
  app.delete('/banned/:market', (req, res) => res.send(_.unset(store, `banned.${req.params.market}`)));
  app.post('/banned/:market', (req, res) => res.send(_.set(store, `banned.${req.params.market}`, req.body)));

  app.post('/settings/:field/:value', (req, res) => {
    const number = _.toNumber(req.params.value);

    return res.send(
      _.set(store.settings, req.params.field, !isNaN(number) ? number : _.get(store.settings, req.params.field))
    );
  });

  app.post('/pause', (req, res) => {
    store.active = false;

    res.send(store.active);
  });
  app.post('/resume', (req, res) => {
    store.active = true;

    res.send(store.active);
  });

  app.post('/mute', (req, res) => {
    store.silent = true;

    res.send(store.silent);
  });
  app.post('/unmute', (req, res) => {
    store.silent = false;

    res.send(store.silent);
  });

  addRoutes(app);

  app.get('*', (req, res) => {
    const path = _.trim(req.path.replace(/\//g, '.'), '.');
    const value = _.get(store, path);

    if (value !== void 0 && value !== null) {
      return res.json(value);
    }

    res.status(404).end();
  });

  app.listen(port, () => console.log('HTTP interface available on port', port));

  return app;
};
