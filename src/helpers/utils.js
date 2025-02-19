const _ = require('lodash');
const cache = require('../services/cache');
const queue = require('../queue');
const logger = require('../logger');
const registry = require('../services/registry');
const config = require('../config');

const maxAge = config.get('settings:cache_ttl');
const autoSyncMSec = config.get('settings:autosync_min') * 60 * 1000;

/**
 * Helper function for pulling content
 *
 * @param {*} req
 * @param {*} res
 * @param {String} key
 * @param {Object} filter
 * @param {Function} syncFunc
 * @param {*} syncFuncParams
 * @returns {Object}
 */
async function routerCacheHelper(req, res, key, filter, syncFunc, ...syncFuncParams) {
  // helper function to add sync job once
  let jobAdded = false;
  function addJob() {
    if (jobAdded) return;
    jobAdded = true;
    // refresh data async
    queue.addJob(key, {
      type: 'syncer:pull',
      key,
      token: req.token,
      filter,
      syncFunc,
      syncFuncParams,
    });
  }

  let sentContent = false;

  try {
    const rdata = (await registry.get(`cache:${key}`)) || {};
    switch (rdata.status) {
      case 'success':
        if (req.header('If-None-Match')
          && req.header('If-None-Match') === rdata.etag
        ) {
          res.status(304)
            .set('ETag', req.header('If-None-Match'))
            .send();
          sentContent = true;
        } else if (rdata.location.startsWith('cache://')) {
          const cdata = await cache.getContent(rdata.location.replace('cache://', ''));
          if (cdata && cdata.data) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('ETag', rdata.etag);
            res.setHeader('Cache-Control', `max-age=${maxAge}`);
            res.send(cdata.data);
            sentContent = true;
          } else {
            res.status(202).send();
            addJob();
          }
        } else {
          res.redirect(rdata.location);
          sentContent = true;
        }
        // check for auto refresh
        if ((Date.now() - rdata.ts) >= autoSyncMSec) {
          addJob();
        }
        break;
      case 'error':
        res.status(rdata.statusCode).send(rdata.statusMessage);
        break;
      default:
        res.status(202).send();
        addJob();
        break;
    }
  } catch (e) {
    logger.error(e);
    res.sendStatus(500);
  }

  return sentContent;
}

/**
 * Check if non-empty array
 * contains non-empty sub-array
 *
 * @param {Array} array
 * @param {Array} partial
 * @returns {Boolean}
 */
function arrayContainsArray(array, partial) {
  if (_.isEmpty(array) || _.isEmpty(partial)) return false;
  return partial.every((val) => array.includes(val));
}

/**
 * Clean and sanitize a tags string, e.g.
 * "tag1,  tag2," ->  "tag1,tag2"
 *
 * @param {String} tagsStr
 * @returns {String}
 */
function cleanTags(tagsStr) {
  // convert to array
  let tags = (tagsStr || '').split(',');
  // remove whitespace
  tags = _.map(tags, (tag) => tag.trim());
  // sort and remove empty values
  tags = _.compact(tags.sort());
  // convert back to string
  tags = tags.join(',');
  return tags;
}

module.exports = {
  routerCacheHelper,
  arrayContainsArray,
  cleanTags,
};
