'use strict';

const { loadEventFromRow, loadLinkFromRow } = require('./memory-store-row-codec');

function createLazyEventArray(store) {
  const target = [];
  return new Proxy(target, {
    get(arr, prop, receiver) {
      if (prop === 'length') {
        if (store && store._db) {
          try {
            const row = store._db.prepare('SELECT count(*) AS count FROM memory_events').get();
            return row ? row.count : arr.length;
          } catch (_) {
            return arr.length;
          }
        }
        return arr.length;
      }
      if (prop === Symbol.iterator) {
        return function* () {
          if (store && store._db && store._stmts?.allEvents) {
            for (const row of store._stmts.allEvents.iterate()) {
              const event = loadEventFromRow(store, row);
              if (event) yield event;
            }
          } else {
            yield* arr[Symbol.iterator]();
          }
        };
      }
      if (prop === 'filter') {
        return (predicate) => {
          const results = [];
          if (store && store._db && store._stmts?.allEvents) {
            for (const row of store._stmts.allEvents.iterate()) {
              const event = loadEventFromRow(store, row);
              if (event && predicate(event)) results.push(event);
            }
          } else {
            for (const item of arr) {
              if (predicate(item)) results.push(item);
            }
          }
          return results;
        };
      }
      if (prop === 'find') {
        return (predicate) => {
          if (store && store._db && store._stmts?.allEvents) {
            for (const row of store._stmts.allEvents.iterate()) {
              const event = loadEventFromRow(store, row);
              if (event && predicate(event)) return event;
            }
          } else {
            return arr.find(predicate);
          }
          return undefined;
        };
      }
      if (prop === 'map') {
        return (fn) => {
          const results = [];
          if (store && store._db && store._stmts?.allEvents) {
            for (const row of store._stmts.allEvents.iterate()) {
              const event = loadEventFromRow(store, row);
              if (event) results.push(fn(event));
            }
          } else {
            return arr.map(fn);
          }
          return results;
        };
      }
      return Reflect.get(arr, prop, receiver);
    },
  });
}

function createLazyLinkArray(store) {
  const target = [];
  return new Proxy(target, {
    get(arr, prop, receiver) {
      if (prop === 'length') {
        if (store && store._db) {
          try {
            const row = store._db.prepare('SELECT count(*) AS count FROM memory_links').get();
            return row ? row.count : arr.length;
          } catch (_) {
            return arr.length;
          }
        }
        return arr.length;
      }
      if (prop === Symbol.iterator) {
        return function* () {
          if (store && store._db && store._stmts?.allLinks) {
            for (const row of store._stmts.allLinks.iterate()) {
              const link = loadLinkFromRow(store, row);
              if (link) yield link;
            }
          } else {
            yield* arr[Symbol.iterator]();
          }
        };
      }
      if (prop === 'filter') {
        return (predicate) => {
          const results = [];
          if (store && store._db && store._stmts?.allLinks) {
            for (const row of store._stmts.allLinks.iterate()) {
              const link = loadLinkFromRow(store, row);
              if (link && predicate(link)) results.push(link);
            }
          } else {
            for (const item of arr) {
              if (predicate(item)) results.push(item);
            }
          }
          return results;
        };
      }
      if (prop === 'find') {
        return (predicate) => {
          if (store && store._db && store._stmts?.allLinks) {
            for (const row of store._stmts.allLinks.iterate()) {
              const link = loadLinkFromRow(store, row);
              if (link && predicate(link)) return link;
            }
          } else {
            return arr.find(predicate);
          }
          return undefined;
        };
      }
      if (prop === 'map') {
        return (fn) => {
          const results = [];
          if (store && store._db && store._stmts?.allLinks) {
            for (const row of store._stmts.allLinks.iterate()) {
              const link = loadLinkFromRow(store, row);
              if (link) results.push(fn(link));
            }
          } else {
            return arr.map(fn);
          }
          return results;
        };
      }
      return Reflect.get(arr, prop, receiver);
    },
  });
}

module.exports = {
  createLazyEventArray,
  createLazyLinkArray,
};
