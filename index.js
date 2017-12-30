const crypto = require('crypto');
const axios = require('axios');
const EventEmitter = require('events');
const growl = require('growl');
const argv = require('minimist')(process.argv.slice(2));
const _ = require('lodash');
const moment = require('moment-timezone');
const bittrex = require('./node.bittrex.api');

const websockets_baseurl = 'wss://socket.bittrex.com/signalr';
const websockets_hubs = ['CoreHub'];

const server = require('./server');

moment.tz.setDefault('GMT');

const store = {
  markets: [],
  values: {},
  orders: [],
  history: [],
  balance: {},
  banned: {
    'BTC-RDD': {
      count: Number.MAX_SAFE_INTEGER,
      market: 'BTC-RDD',
      rate: {
        value: 9e-8,
        time: 1513072524,
      },
    },
    'BTC-DOGE': {
      count: Number.MAX_SAFE_INTEGER,
      market: 'BTC-DOGE',
      rate: {
        value: 9e-8,
        time: 1513072524,
      },
    },
  },
  rising: {},
  result: {
    active: 0,
    finished: 0,
  },
  active: false,
  silent: true,
  stats: {},
  connection: {
    active: false,
  },
  settings: {
    rising_count_threshold: 2,
    explosion_threshold: 0.01,
    sell_growth_threshold_1: 0.02,
    sell_growth_threshold_2: 0.01,
    sell_growth_threshold_3: 0.01,
    sell_growth_threshold_2_minutes: 10,
    sell_growth_threshold_3_minutes: 30,
    sell_fall_threshold: -2,
    check_rate_period_minutes: 1,
    stats_period_minutes: 5, // update this value after start
    not_for_trade: ['ETH', 'MONA', 'MANA', 'BSD', 'MEME', 'NXT'],
    real_orders: argv['r'] || false,
    growing_markets_percent: 50,
    comments: '',
  },
};

const emitter = new EventEmitter();

const API_KEY = argv['k'];
const API_SECRET = argv['s'];
const PORT = argv['p'];
const ORDER_AMOUNT_BTC = argv['a'] || 0.001;

const router = server(store, PORT);

if (store.settings.real_orders) {
  console.log('$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$');
  console.log('$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$');
  console.log('$$$$$$$    USING REAL MONEY    $$$$$$$');
  console.log('$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$');
  console.log('$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$');
}

function getHash(string) {
  var hmac = crypto.createHmac('sha512', key);
  hmac.update(string);

  return hmac.digest('binary');
}

function getNonce() {
  return moment().unix();
}

function getPrivateUri(uri, nonce) {
  if (_.isEmpty(API_KEY)) {
    throw new Error('API KEY not provided');
  }

  return `${uri}${uri.indexOf('?') === -1 ? '?' : '&'}apikey=${API_KEY}&nonce=${nonce}`;
}

function signUri(uri, nonce) {
  if (_.isEmpty(API_SECRET)) {
    throw new Error('API SECRET not provided');
  }

  const hmac = crypto.createHmac('sha512', API_SECRET);
  hmac.update(uri);

  return hmac.digest('hex');
}

function getHeaders(signature) {
  return {
    headers: {
      apisign: signature,
    },
  };
}

function getMarkets() {
  return axios.get('https://bittrex.com/api/v1.1/public/getmarkets').then(response => response.data.result);
}

function getRate(market) {
  const url = `http://bittrex.com/api/v1.1/public/getmarketsummary?market=${market}`;

  return axios.get(url).then(response => ({
    value: response.data.result.Last,
    market: response.data.result.MarketName,
    time: response.data.result.TimeStamp,
  }));
}

function buylimit(market, rate) {
  const amount = (0.0011 / rate).toFixed(6);
  console.log(`Trying to BUY ${amount} ${market.substring(4)} for ${rate} per item. Total BID: ${amount * rate}`);

  if (!store.settings.real_orders) {
    return Promise.resolve({
      success: true,
      result: {
        uuid: 'fakeid',
      }
    });
  }

  const nonce = getNonce();
  const uri = getPrivateUri(
    `https://bittrex.com/api/v1.1/market/buylimit?market=${market}&quantity=${amount}&rate=${rate}`,
    nonce
  );
  const signature = signUri(uri, nonce);

  return axios.get(uri, getHeaders(signature)).then(response => response.data);
}

function selllimit(market, rate) {
  const amount = _.get(store.balance, market.substring(4), 0);

  console.log(`Trying to SELL ${amount} ${market.substring(4)} for ${rate} per item. Total ASK: ${amount * rate}`);

  if (!store.settings.real_orders) {
    return Promise.resolve({
      success: true,
      result: {
        uuid: 'fakeid',
      }
    });
  }

  const nonce = getNonce();
  const uri = getPrivateUri(
    `https://bittrex.com/api/v1.1/market/selllimit?market=${market}&quantity=${amount}&rate=${rate}`,
    nonce
  );
  const signature = signUri(uri, nonce);

  return axios.get(uri, getHeaders(signature)).then(response => response.data);
}

function cancelorder(market, id) {
  console.log(`Trying to CANCEL ${market} order ${id}`);

  if (!store.settings.real_orders) {
    return Promise.resolve({
      success: true,
    });
  }

  const nonce = getNonce();
  const uri = getPrivateUri(`https://bittrex.com/api/v1.1/market/cancel?uuid=${id}`, nonce);
  const signature = signUri(uri, nonce);

  return axios.get(uri, getHeaders(signature)).then(response => response.data);
}

function getRates(market) {
  const url = `http://bittrex.com/api/v1.1/public/getmarketsummaries`;

  return axios.get(url).then(response =>
    response.data.result.filter(m => m.MarketName.indexOf('BTC-') === 0).map(m => ({
      value: m.Last,
      market: m.MarketName,
      time: m.TimeStamp,
    }))
  );
}

function getBalance() {
  const nonce = getNonce();
  const uri = getPrivateUri('https://bittrex.com/api/v1.1/account/getbalances', nonce);
  const signature = signUri(uri, nonce);

  return axios.get(uri, getHeaders(signature)).then(response => response.data.result);
}

// update results
emitter.on('result', (market, rate, order, change) => {
  const old = store.result.finished;

  store.result.finished = store.history.reduce((acc, o) => (acc += o.change), 0);
  store.result.active = store.orders.reduce((acc, o) => (acc += o.change), 0);

  if (change < 0) {
    _.set(store.banned, market, {
      ...order,
      count: _.get(store.banned, `${market}.count`, 0) + 1,
    });

    _.set(store.rising, market, {
      ...rate,
      count: 0,
    });
  } else {
    _.set(store.banned, `${market}.count`, 0);
  }

  console.log('==========================');
  console.log('Result changed.', market);
  console.log('Buy rate:', order.rate.value.toFixed(8), '. Sell rate:', rate.value.toFixed(8));
  console.log('Spent BTC:', ORDER_AMOUNT_BTC, '. Buy amount:', (ORDER_AMOUNT_BTC / order.rate.value).toFixed(4));
  console.log('Received BTC:', (ORDER_AMOUNT_BTC / order.rate.value * rate.value).toFixed(5));
  console.log('Prev result:', old.toFixed(8), '. New value:', store.result.finished.toFixed(8));
  console.log('==========================');
});

emitter.on('result', (market, rate, order, change) => {
  if (store.silent) {
    return;
  }

  growl(`Order: ${change.toFixed(3)}% on ${market}`, {
    name: 'bittrex-notifier',
    group: 'bittrex',
    title: `Bittrex:${PORT}`,
    image: 'logo.png',
    url: `https://bittrex.com/Market/Index?MarketName=${market}`,
    sound: 'default',
  });
});

const minmaxdefault = {
  min: {
    value: Number.MAX_SAFE_INTEGER,
    time: 0,
  },
  max: {
    value: 0,
    time: 0,
  },
};

function updateBalances() {
  return getBalance()
    .then(balances => balances.filter(m => !!m.Balance))
    .then(balances => {
      balances.forEach(b => {
        _.set(store.balance, b.Currency, b.Balance);
      });

      console.log('Balances updated');

      return balances;
    })
    .catch(err => console.warn('Error:', err.message));
}

updateBalances();

// get market tickers
const markets = getMarkets();

markets
  .then(markets => markets.filter(m => m.BaseCurrency === 'BTC'))
  .then(markets => markets.map(m => m.MarketName))
  .then(markets => {
    _.set(store, 'markets', markets);

    emitter.emit('markets', markets);

    return markets;
  })
  .catch(err => console.warn('Error:', err.message));

emitter.on('markets', markets => {
  bittrex.websockets.subscribe(markets, data => {
    if (data.M === 'updateExchangeState') {
      data.A.forEach(function (data_for) {
        const market = data_for.MarketName;
        const rates = data_for.Fills.map(f => ({
          value: f.Rate,
          time: moment(f.TimeStamp).unix(),
        }));

        if (rates.length) {
          emitter.emit('rates', market, rates);
        }
      });
    }
  });
});

emitter.on('rates', (market, rates) => {
  const now = moment().unix();
  const newrates = _.get(store.values, market, []).concat(rates);

  const periodStartIndex = _.findLastIndex(newrates, r => now - r.time > store.settings.check_rate_period_minutes * 60);
  const statsPeriodStartIndex = _.findLastIndex(newrates, r => now - r.time > store.settings.stats_period_minutes * 60);

  store.result.active = store.orders.reduce((acc, o) => (acc += o.change), 0);

  if (periodStartIndex > 0) {
    const periodRates = newrates.slice(periodStartIndex);

    _.set(store.values, market, statsPeriodStartIndex > -1 ? newrates.slice(statsPeriodStartIndex) : newrates);

    const getValue = r => r.value;
    const first = _.first(periodRates);
    const last = _.last(periodRates);
    const max = _.maxBy(periodRates, getValue);
    const min = _.minBy(periodRates, getValue);
    const mean = _.meanBy(periodRates, getValue);
    const half = (max.value - min.value) / 2 + min.value;

    const change = max.value / min.value - 1;

    if (max.time > min.time && last.value > first.value && mean > half) {
      // mean > half on 3000 port
      if (change > store.settings.explosion_threshold) {
        emitter.emit('_explosion', market, _.last(rates), change, store.settings.check_rate_period_minutes);
      }
    }
  } else {
    _.set(store.values, market, newrates);
  }
});

// buy on explosive market
emitter.on('_explosion', (market, rate, change, period) => {
  const banned = store.banned[market] && store.banned[market].count > 2;

  if (store.active && !store.orders.some(o => o.market === market) && !banned) {
    if (store.settings.not_for_trade.indexOf(market.substring(4)) > -1) {
      return;
    }

    if (store.settings.real_orders && _.get(store.balance, market.substring(4), 0)) {
      console.warn(`Trying to buy ${market} with non-zero balance`);
      return;
    }

    const rising = _.get(store.rising, market, {
      count: 0,
      ...rate,
    });

    if (rising.count < store.settings.rising_count_threshold) {
      const timediff = rate.time - rising.time;

      if ((rising.count == 0 && timediff === 0) || timediff > store.settings.check_rate_period_minutes * 60) {
        rising.count && console.log('UPDATE GROWTH:', market, rate.time, rising.time, timediff);

        _.set(store.rising, market, {
          count: rising.count + 1,
          ...rate,
        });
      }

      return;
    }

    buylimit(market, rate.value)
      .then(res => {
        if (res.success) {
          console.log('BUY order placed');

          updateBalances();

          _.defer(() =>
            store.orders.push({
              market,
              rate,
              change: 0,
              amount: 0.00001,
              id: res.result.uuid,
            })
          );

          emitter.emit('buy', market, rate, change, period);
        } else {
          console.log(res);
        }
      })
      .catch(err => console.warn(`BUY err: ${err.message}`));
  }
});

emitter.on('rates', (market, rates) => {
  store.orders.filter(o => o.market === market).forEach(order => {
    const now = moment().unix();
    const rate = _.last(rates);
    const change = rate.value / order.rate.value - 1;

    const orderIndex = _.findIndex(store.orders, o => o.market === market);

    _.set(store.orders, `${orderIndex}.change`, change);

    if (
      change >= store.settings.sell_growth_threshold_1 ||
      (change >= store.settings.sell_growth_threshold_2 && now - store.orders[orderIndex].rate.time > store.settings.sell_growth_threshold_2_minutes * 60) ||
      (change >= store.settings.sell_growth_threshold_3 && now - store.orders[orderIndex].rate.time > store.settings.sell_growth_threshold_3_minutes * 60)
    ) {
      if (store.settings.real_orders && !_.get(store.balance, market.substring(4), 0)) {
        console.warn();
        console.warn();
        console.warn(`Trying to sell ${market} with zero balance`);
        console.warn();
        console.warn();
        cancelorder(market, order.id).then(res => {
          if (res.success) {
            console.log(`Order for ${market} canceled`);
          } else {
            console.warn(res);
          }

          _.remove(store.orders, o => o.market === market);
        });
        return;
      }

      selllimit(market, rate.value).then(res => {
        if (res.success) {
          console.log('SELL order placed');

          // remove order from active orders and add to history
          const [order] = _.remove(store.orders, o => o.market === market);

          store.history = store.history.concat([{
            market,
            open: order.rate,
            close: rate,
            change,
            id: res.result.uuid,
          }, ]);

          emitter.emit('result', market, rate, order, change);
        } else {
          console.log(res);
        }
      });
    }
  });
});

emitter.on('buy', (market, rate, change, period) => {
  if (store.orders.some(o => o.market === market) || store.banned[market]) {
    return;
  }

  if (store.silent) {
    return;
  }

  growl(`Buy ${market}`, {
    group: 'bittrex',
    title: `Bittrex:${PORT}`,
    subtitle: `Growth ${change.toFixed(3)}% in ${period} minutes`,
    image: 'logo.png',
    url: `https://bittrex.com/Market/Index?MarketName=${market}`,
    sound: 'default',
  });
});

function updateStats(fromTimestamp) {
  const marketsStats = Object.keys(store.values).reduce(
    (acc, m) => {
      const values = store.values[m];

      const first = _.first(values);
      const last = _.last(values);

      return {
        totalGrowth: acc.totalGrowth + last.value / first.value,
        growingMarketsNumber: acc.growingMarketsNumber + (last.value > first.value ? 1 : 0),
      };
    }, {
      totalGrowth: 0,
      growingMarketsNumber: 0,
    }
  );

  console.log('total markets count', Object.keys(store.values).length);
  console.log('growing markets count', marketsStats.growingMarketsNumber);

  marketsStats.growingMarketsPercent = (
    marketsStats.growingMarketsNumber /
    Object.keys(store.values).length *
    100
  ).toFixed(2);

  if (marketsStats.growingMarketsPercent < store.settings.growing_markets_percent && store.active) {
    store.active = false;
    store.rising = {};

    growl(`Change state`, {
      group: 'bittrex',
      title: `Bittrex:${PORT}`,
      subtitle: `Set script inactive ${marketsStats.growingMarketsPercent}`,
      image: 'logo.png',
      sound: 'default',
    });
  } else if (marketsStats.growingMarketsPercent >= store.settings.growing_markets_percent && !store.active) {
    store.active = true;

    growl(`Change state`, {
      group: 'bittrex',
      title: `Bittrex:${PORT}`,
      subtitle: `Set script active ${marketsStats.growingMarketsPercent}`,
      image: 'logo.png',
      sound: 'default',
    });
  }

  const now = moment();

  const filter = field => order => order[field].time > fromTimestamp;

  const closedFilter = filter('close');
  const activeFilter = filter('rate');

  const closed = _.filter(store.history, closedFilter);
  const active = _.filter(store.orders, activeFilter);

  const closedStats = closed.reduce((acc, o) => (acc += o.close.value / o.open.value - 1), 0);
  const activeStats = active.reduce((acc, o) => (acc += o.change), 0);

  if (closedStats || activeStats) {
    _.set(store.stats, now.format('DD/MM/YY HH:mm:ss'), {
      closed: closedStats,
      active: activeStats,
      marketsStats: {
        open: _.get(store.stats, 'markets.growingMarketsPercent', 0),
        close: marketsStats.growingMarketsPercent,
      },
    });
  }

  _.set(store.stats, 'markets', marketsStats);

  if (store.connection.active) {
    setTimeout(updateStats.bind(null, now.unix()), store.settings.stats_period_minutes * 60 * 1000);
  }
}

bittrex.options({
  websockets: {
    onConnect: function () {
      console.log('Websocket connected');
      _.set(store.connection, 'active', true);

      setTimeout(updateStats.bind(null, moment().unix()), store.settings.stats_period_minutes * 60 * 1000);
    },
    onDisconnect: function () {
      console.log('Websocket disconnected');
      _.set(store.connection, 'active', false);
    },
  },
});
