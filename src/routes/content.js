const express = require('express');
const dayjs = require('dayjs');
const md5 = require('md5');
const _ = require('lodash');
const slugify = require('slugify');
const config = require('../config');
const { validateHeader } = require('../middlewares/headers');
const syncer = require('../services/syncer/data');
const registry = require('../services/registry');
const { cleanTags, routerCacheHelper } = require('../helpers/utils');
const logger = require('../logger');

const router = express.Router();

const timeoutMsec = config.get('settings:upload_timeout_min') * 60 * 1000;
const hasAnalytics = config.get('analytics:enabled');
const analyticsRetentionSec = config.get('analytics:retention_days') * 24 * 60 * 60;

router.get('/:lang_code',
  validateHeader('public'),
  async (req, res) => {
    // pattern is:
    // - token:lang:content
    // - token:lang:content[tag1,tag2]
    let key = `${req.token.project_token}:${req.params.lang_code}:content`;

    // parse tags filter
    let filter = {};
    const tags = cleanTags(_.get(req.query, 'filter.tags'));
    if (tags) {
      // update filter
      filter = {
        tags,
      };
      // add tags to key
      key = `${key}[${tags}]`;
    }
    const sentContent = await routerCacheHelper(
      req, res,
      key, filter,
      'getProjectLanguageTranslations', req.params.lang_code,
    );
    if (hasAnalytics && sentContent) {
      const clientId = md5(req.ip || 'unknown');

      const project = req.token.project_token;
      const lang = req.params.lang_code;
      const sdkVersion = slugify(req.headers['x-native-sdk'] || 'unknown');

      const dateDay = dayjs().format('YYYY-MM-DD');
      const keyDay = `analytics:${project}:${dateDay}`;
      if (await registry.addToSet(`${keyDay}:clients`, clientId, analyticsRetentionSec)) {
        registry.incr(`${keyDay}:lang:${lang}`, 1, analyticsRetentionSec);
        registry.incr(`${keyDay}:sdk:${sdkVersion}`, 1, analyticsRetentionSec);
      }
    }
  });

router.post('/:lang_code',
  validateHeader('private'),
  async (req, res) => {
    req.setTimeout(timeoutMsec);
    try {
      const data = await syncer.pushTranslations(
        { token: req.token }, req.params.lang_code, req.body.data,
      );
      res.json(data);
    } catch (e) {
      if (e.status) {
        res.status(e.status).json({
          status: e.status,
          message: e.message,
          details: e.details,
        });
      } else {
        logger.error(e);
        res.status(500).json({
          status: 500,
          message: 'An error occured!',
        });
      }
    }
  });

router.post('/',
  validateHeader('private'),
  async (req, res) => {
    req.setTimeout(timeoutMsec);
    try {
      const data = await syncer
        .pushSourceContent({ token: req.token }, req.body);

      let status = 200;
      if (data.errors.length) status = 409;

      res.status(status).json(data);
    } catch (e) {
      if (e.status) {
        if (e.status !== 401) logger.error(e);
        res.status(e.status).json({
          status: e.status,
          message: e.message,
          details: e.details,
        });
      } else {
        logger.error(e);
        res.status(500).json({
          status: 500,
          message: 'An error occured!',
        });
      }
    }
  });

module.exports = router;
