'use strict';

const debug = require('debug')('koa-session:context');
const Session = require('./session');
const util = require('./util');

const ONE_DAY = 24 * 60 * 60 * 1000;
//TODO externalKey是指在redis中的key
class ContextSession {
  /**
   * context session constructor
   * @api public
   */

  constructor(ctx, opts) {
    this.ctx = ctx;
    this.opts = opts || {};
    this.store = this.opts.ContextStore ? new this.opts.ContextStore(ctx) : this.opts.store;
  }

  /**
   * internal logic of `ctx.session`
   * @return {Session} session object
   *
   * @api public
   */
  //TODO 每个请求进入中间件，就会执行这个，用于得到或创建session
  get() {
    const session = this.session;
    // already retrieved
    if (session) return session;
    // unset
    if (session === false) return null;

    // cookie session store
    if (!this.store) this.initFromCookie();
    return this.session;
  }

  /**
   * internal logic of `ctx.session=`
   * @param {Object} val session object
   *
   * @api public
   */
  //TODO 设置session
  set(val) {
    if (val === null) {
      this.session = false;
      return;
    }
    if (typeof val === 'object') {
      // use the original `externalKey` if exists to avoid waste storage
      this.create(val, this.externalKey);
      return;
    }
    throw new Error('this.session can only be set as null or an object.');
  }

  /**
   * init session from external store
   * will be called in the front of session middleware
   *
   * @api public
   */
  //TODO 创建带缓存层的session
  async initFromExternal() {
    debug('init from external');
    const ctx = this.ctx;
    const opts = this.opts;
    //TODO 得到缓存层的key，有缓存层时session就是个key
    const externalKey = ctx.cookies.get(opts.key, opts);
    debug('get external key from cookie %s', externalKey);
    //TODO 如果不存在key
    if (!externalKey) {
      // create a new `externalKey`
      this.create();
      return;
    }

    const json = await this.store.get(externalKey, opts.maxAge, { rolling: opts.rolling });
    //TODO 如果已经过期
    if (!this.valid(json)) {
      // create a new `externalKey`
      this.create();
      return;
    }

    // create with original `externalKey`
    this.create(json, externalKey);
    this.prevHash = util.hash(this.session.toJSON());
  }

  /**
   * init session from cookie
   * @api private
   */
  //TODO 创建没有缓存层的session
  initFromCookie() {
    debug('init from cookie');
    const ctx = this.ctx;
    const opts = this.opts;
    //TODO 没有缓存层的session包含了所有数据，opts只是为了signed参数
    const cookie = ctx.cookies.get(opts.key, opts);
    //TODO 第一次请求没有session那就创建
    if (!cookie) {
      this.create();
      return;
    }

    let json;
    debug('parse %s', cookie);
    try {
      //TODO 解码得到数据
      json = opts.decode(cookie);
    } catch (err) {
      // backwards compatibility:
      // create a new session if parsing fails.
      // new Buffer(string, 'base64') does not seem to crash
      // when `string` is not base64-encoded.
      // but `JSON.parse(string)` will crash.
      debug('decode %j error: %s', cookie, err);
      if (!(err instanceof SyntaxError)) {
        //TODO 删除session
        // clean this cookie to ensure next request won't throw again
        ctx.cookies.set(opts.key, '', opts);
        // ctx.onerror will unset all headers, and set those specified in err
        err.headers = {
          'set-cookie': ctx.response.get('set-cookie'),
        };
        throw err;
      }
      this.create();
      return;
    }

    debug('parsed %j', json);
    //TODO 验证是否过期
    if (!this.valid(json)) {
      this.create();
      return;
    }
    //TODO 创建带数据的session
    // support access `ctx.session` before session middleware
    this.create(json);
    this.prevHash = util.hash(this.session.toJSON());
  }

  /**
   * verify session(expired or )
   * @param  {Object} json session object
   * @return {Boolean} valid
   * @api private
   */
  //TODO 验证session是否过期
  valid(json) {
    if (!json) return false;
    //TODO 如果session过期
    if (json._expire && json._expire < Date.now()) {
      debug('expired session');
      return false;
    }
    //TODO 用户自己的验证规则
    const valid = this.opts.valid;
    if (typeof valid === 'function' && !valid(this.ctx, json)) {
      // valid session value fail, ignore this session
      debug('invalid session');
      return false;
    }
    return true;
  }

  /**
   * create a new session and attach to ctx.sess
   *
   * @param {Object} [val] session data
   * @param {String} [externalKey] session external key
   * @api private
   */
  //TODO 创建session，没有参数时创建空session
  create(val, externalKey) {
    debug('create session with val: %j externalKey: %s', val, externalKey);
    //TODO 如果使用缓存层，就添加缓存的key
    if (this.store) this.externalKey = externalKey || this.opts.genid();
    //TODO 创建session
    this.session = new Session(this.ctx, val);
  }

  /**
   * Commit the session changes or removal.
   *
   * @api public
   */
  //TODO save的hook
  async commit() {
    const session = this.session;
    const prevHash = this.prevHash;
    const opts = this.opts;
    const ctx = this.ctx;

    // not accessed
    if (undefined === session) return;

    // removed
    if (session === false) {
      await this.remove();
      return;
    }

    // force save session when `session._requireSave` set
    let changed = true;
    if (!session._requireSave) {
      const json = session.toJSON();
      // do nothing if new and not populated
      if (!prevHash && !Object.keys(json).length) return;
      changed = prevHash !== util.hash(json);
      // do nothing if not changed and not in rolling mode
      if (!this.opts.rolling && !changed) return;
    }

    if (typeof opts.beforeSave === 'function') {
      debug('before save');
      opts.beforeSave(ctx, session);
    }
    await this.save(changed);
  }

  /**
   * remove session
   * @api private
   */
  //TODO 移除session
  async remove() {
    const opts = this.opts;
    const ctx = this.ctx;
    const key = opts.key;
    const externalKey = this.externalKey;
    //TODO 如果在缓存层当中就把缓存层的删除
    if (externalKey) await this.store.destroy(externalKey);
    //TODO cookie设置为空
    ctx.cookies.set(key, '', opts);
  }

  /**
   * save session
   * @api private
   */
  //TODO 把session返回浏览器
  async save(changed) {
    const opts = this.opts;
    const key = opts.key;
    const externalKey = this.externalKey;
    let json = this.session.toJSON();
    // set expire for check
    //TODO 设置默认的过期水煎
    const maxAge = opts.maxAge ? opts.maxAge : ONE_DAY;
    //TODO 过期时间是session那就是maxAge = undefined
    if (maxAge === 'session') {
      // do not set _expire in json if maxAge is set to 'session'
      // also delete maxAge from options
      opts.maxAge = undefined;
    } else {
      // set expire for check
      json._expire = maxAge + Date.now();
      json._maxAge = maxAge;
    }

    //TODO 有缓存层的话就保存key
    // save to external store
    if (externalKey) {
      debug('save %j to external key %s', json, externalKey);
      await this.store.set(externalKey, json, maxAge, {
        changed,
        rolling: opts.rolling,
      });
      this.ctx.cookies.set(key, externalKey, opts);
      return;
    }
    //TODO 没有缓存层就保存数据
    // save to cookie
    debug('save %j to cookie', json);
    json = opts.encode(json);
    debug('save %s', json);

    this.ctx.cookies.set(key, json, opts);
  }
}

module.exports = ContextSession;
