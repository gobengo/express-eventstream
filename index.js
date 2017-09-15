const grip = require('grip')
const { PassThrough, Transform, Writable } = require('stream')
const debug = require('debug')('express-eventstream')

/**
 * @TODO (bengo) jsdoc all the things, ensure passes eslint
 */

// "A colon as the first character of a line is in essence a comment, and is ignored."
// https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format
const textEventStreamCommentPrefix = ':'
const newline = '\n'
const textEventStream = {
  event: (fields, comments) => {
    let event = ''
    if (comments) {
      if (!Array.isArray(comments)) comments = [comments]
      for (let comment of comments) { event += textEventStreamCommentPrefix + comment + newline }
    }
    if (fields) {
      for (let [field, value] of Object.entries(fields)) {
        event += String(value)
        .split(newline)
        .map(chunk => field + ': ' + chunk)
        .join(newline)
        event += newline
      }
    }
    event += newline
    return event
  },
  stream: (events) => {
    if (!Array.isArray(events)) events = [events]
    return events.join('\n\n') + '\n\n'
  }
}

let encoderId = 0
class ServerSentEventEncoder extends Transform {
  constructor () {
    super({ writableObjectMode: true })
    this._id = String(encoderId++)
  }
  _transform (event, encoding, callback) {
    this.push(textEventStream.stream(textEventStream.event(Object.assign({ encoder: this._id }, event))))
    callback()
  }
}

/**
 * given an http request, return an object with any grip-specific instructions (by parsing headers)
 * If there is no sign of the client speaking grip, return falsy
 * @param {http.IncomingMessage} req - http request
 */
function gripRequestFromHttp (req) {
  const gripRequest = Array.from(Object.entries(req.headers)).reduce((gripRequest, [header, value]) => {
    if (header.toLowerCase().startsWith('grip-')) {
      const key = header.replace(/^Grip-/i, '')
      gripRequest[key] = value
    }
    return gripRequest
  }, {})
  if (!Object.keys(gripRequest).length) {
    // was not grippy
    return
  }
  return gripRequest
}

/**
 * Writable stream that publishes written events to a Grip Control Publish endpoint
 */
class GripPubControlWritable extends Writable {
  constructor (gripPubControl, channelName) {
    super({
      objectMode: true,
      write (event, encoding, callback) {
        new Promise((resolve, reject) => gripPubControl.publishHttpStream(channelName, event, (success, message, context) => {
          if (success) {
            this.emit('grip:published', event)
            resolve()
          } else {
            reject(new GripPublishFailedError(message, context))
          }
        }))
          .catch(callback)
          .then(callback)
      }
    })
  }
}

/**
 * Create an express middleware for an EventStream.
 * The middleware will respond to HTTP requests from Pushpin in order to
 * deliver any Events written to the EventStream
 * @param {stream.Readable} options.events - stream of Event objects that will be sent to users
 * @param {Object} options.grip - Grip options
 * @param {String} options.grip.key - secret key that will be used to validate Grip-Sig headers
 * @param {String} options.grip.controlUri - URI of Control Plane server that will be used to publish events when using GRIP
 */
exports.createMiddleware = function (options = {}) {
  options = Object.assign({ grip: {} }, options)
  const controlUri = options.grip.controlUri
  if (!controlUri) {
    console.warn('Will not be able to publish to gripPubControl with falsy uri: ', controlUri)
  }
  const gripPubControlOptions = {
    control_uri: controlUri,
    key: options.grip.key
  }
  const gripPubControl = options.gripPubControl || new grip.GripPubControl(gripPubControlOptions)
  const encodedEventStream = new ServerSentEventEncoder()
  const pubControlWritable = new GripPubControlWritable(gripPubControl, 'events-public')
    .on('grip:published', (event) => debug('published to gripPubControl', event))
  // buffer of events that should be sent to responses, pushpin
  const events = new PassThrough({ objectMode: true })

  // buffer for those going to pub control over HTTP requests
  const eventsForPubControl = new PassThrough({ objectMode: true })
  events.pipe(eventsForPubControl).pipe(pubControlWritable)

  // separate PassThrough here so buffering occurs here and pubcontrol stream gets events as fast as possible
  const eventsForHttpResponses = new PassThrough({ objectMode: true })
  events.pipe(eventsForHttpResponses).pipe(encodedEventStream)

  // start pumping from user's input events
  const userEvents = options.events
  if (userEvents && userEvents.pipe) {
    userEvents.pipe(events)
  } else {
    console.warn('No events will flow because none provided via options.events')
  }

  let nextMessageId = 0
  return httpRequestHandler(async function (req, res, next) {
    debug('in express-eventstream request handler', req.params, req.method, req.url, req.headers)

    const gripRequest = gripRequestFromHttp(req)
    debug('gripRequest', gripRequest)

    if (gripRequest && gripRequest.sig && !grip.validateSig(gripRequest.sig, options.grip.key)) {
      throw new GripSigInvalidError('Grip-Sig invalid')
    }
    // const eventRequest = await (options.createEventRequest || createEventRequest)(req)

    const initialEvents = []

    // TODO: may only be needed for certain browsers: https://github.com/Yaffle/EventSource/blob/master/README.md#browser-support
    // Don't send if not needed because it's just wasting data on mobile connections
    const userAgentRequiresPaddingBytes = 2048
    if (userAgentRequiresPaddingBytes) {
      initialEvents.push(textEventStream.event(null, Buffer.alloc(userAgentRequiresPaddingBytes).fill(' ').toString()))
    }

    initialEvents.push(textEventStream.event({
      id: String(++nextMessageId),
      event: 'stream-open',
      data: ''
    }))

    res.format({
      'text/event-stream': () => {
        res.status(200)

        if (gripRequest) {
          res.setHeader('Grip-Hold', 'stream')
        } else {
          // do normal SSE over chunked HTTP
          res.setHeader('Connection', 'Transfer-Encoding')
          res.setHeader('Transfer-Encoding', 'chunked')
        }

        // TODO: may need to not do this if it's a gripRequest re-connecting/paging
        // TODO: maybe dont include padding bytes if pushpin/grip
        res.write(textEventStream.stream(initialEvents))

        if (gripRequest) {
          // return early. user events will be delivered via pubcontrol
          debug('its grip, returning early')
          res.end()
          return
        }

        // @TODO (bengo) all responses will only go as fast as the slowest response socket. Might be good to use something like
        // npm.im/fastest-writable to drop slow connections (who could recover via lastEventId) (https://stackoverflow.com/a/33879208 might also be useful)
        debug('piping encoded to res')
        encodedEventStream
          .pipe(res.on('finish', () => debug('response finish (no more writes)'))
                   .on('close', () => debug('response close')))
      },
      'default': () => res.status(406).send('Not Acceptable')
    })
  })
}

/**
 * Create an EventRequest from an express http request.
 * An EventRequest specifies what types of events a client wants.
 * Default implementation. An alternative can be provided on createMiddleware()
 */
// function createEventRequest (httpRequest) {
//   const channels = httpRequest.query.channels
//   return { channels }
// }

/*
Wrap an async function and return an Express http handler
usage:
  express().get('/route', httpRequestHandler(async (req, res, next) => {
    throw 'thrown errors will get sent to next()'
  }))
*/
function httpRequestHandler (handleRequest) {
  return async (req, res, next) => {
    let calledNext = false
    let nextForExpress = (...args) => {
      calledNext = true
      next(...args)
    }
    try {
      await handleRequest(req, res, nextForExpress)
    } catch (error) {
      return nextForExpress(error)
    }
    if (!calledNext) nextForExpress()
  }
}

// Base Class for custom errors
// https://stackoverflow.com/a/31090384
class ExtendableError extends Error {
  constructor (message) {
    super(message)
    this.name = this.constructor.name
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor)
    } else {
      this.stack = (new Error(message)).stack
    }
  }
}

class ExpressEventStreamError extends ExtendableError {}

class GripSigInvalidError extends ExpressEventStreamError {}

class GripPublishFailedError extends ExpressEventStreamError {
  constructor (message, context) {
    super()
    Object.assign(this, { context })
  }
}

/**
# -*- coding: utf-8 -*-
from __future__ import unicode_literals

from django.conf import settings
from django.http import HttpResponseBadRequest

def events(request):
  from .eventrequest import EventRequest
  from .eventstream import EventPermissionError, get_events
  from .utils import sse_error_response

  user = None
  if request.user.is_authenticated:
    user = request.user

  try:
    event_request = EventRequest(request)
    event_response = get_events(event_request, user=user)
    response = event_response.to_http_response(request)
  except EventRequest.ResumeNotAllowedError as e:
    response = HttpResponseBadRequest(
      'Invalid request: %s.\n' % str(e))
  except EventRequest.GripError as e:
    if request.grip_proxied:
      response = sse_error_response(
        'internal-error',
        'Invalid internal request.')
    else:
      response = sse_error_response(
        'bad-request',
        'Invalid request: %s.' % str(e))
  except EventRequest.Error as e:
    response = sse_error_response(
      'bad-request',
      'Invalid request: %s.' % str(e))
  except EventPermissionError as e:
    response = sse_error_response(
      'forbidden',
      str(e),
      {'channels': e.channels})

  response['Cache-Control'] = 'no-cache'

  if hasattr(settings, 'EVENTSTREAM_ALLOW_ORIGIN'):
    cors_origin = settings.EVENTSTREAM_ALLOW_ORIGIN
  else:
    cors_origin = request.META.get('HTTP_HOST')

  if cors_origin:
    response['Access-Control-Allow-Origin'] = cors_origin

  return response

*/
