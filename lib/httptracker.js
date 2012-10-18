const querystring = require('querystring');
const bencode = require('bencode');
const {Logged} = require('log');
const http = require('http');
const url = require('url2');
const {Class} = require('heritage');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const timers = require('timers');

const HttpTracker = Class({
    implements: [Logged, EventTarget],
    initialize: function(url, params) {
        this.url = url;
        this.announce = url.spec;
        this.tag = url.host;
        this.params = params;
    },
    set interval (interval) {
        if (this.timer) {
            timers.clearInterval(this.timer);
        }
        this.timer = timers.setInterval(this.ping.bind(this), interval);
    },
    ping: function() {
        let existingParams = querystring.parse(this.url.query);
        for (name in existingParams) {
            params[name] = existingParams[name];
        }
        this.debug('base url: '+this.url.spec);
        let trackerUrl = url.URL(this.url.filePath + '?' + querystring.stringify(this.params), this.url);
        this.info('pinging tracker '+trackerUrl.spec);
        this.httpRequestHelper(trackerUrl, {}, 10, {
            success: (function(body) {
                try {
                    let result = bencode.decode(body);
                    this.debug('parsed tracker response');
                    emit(this, 'announce', result);
                } catch (e) {
                    this.error('failed to parse tracker response: '+e);
                    emit(this, 'error', e);
                }
            }).bind(this),
            error: (function(error) {
                this.error('tracker responded with error: '+error);
                emit(this, 'error', error);
            }).bind(this)
        });
    },

    // callback(exception, response, body)
    // Handles redirects, coalescing response.

    httpRequestHelper: function(uri, headers, redirectLimit, options) {
        var request = http.ClientRequest({
            uri: uri,
            headers: headers,
            method: 'GET',
        });
        request.on('response', (function(response){
            var statusCode = response.statusCode;
            this.debug('received response. status='+statusCode);
            var body = '';
            if (statusCode == 200) {
                response.setEncoding('binary');
                response.on('error', function(error){
                    options.error(error);
                });
                response.on('end', function(){
                    options.success(body);
                });
                response.on('data', function(chunk){
                    body += chunk;
                });
            } else {
                if (statusCode >= 300 && statusCode <= 399) {
                    if (redirectLimit <= 0) {
                        options.error(Error('too many redirects'));
                    }
                    else {
                        this.info('redirect ' + statusCode + ' ' + JSON.stringify(body));
                        httpRequestHelper(method, host, port, path, headers, redirectLimit - 1, options);
                    }
                } else {
                    options.error(new http.HttpError(statusCode));
                }
            }
        }).bind(this));
        request.end();
    }
});

exports.HttpTracker = HttpTracker;
