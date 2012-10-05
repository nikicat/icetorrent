const querystring = require('querystring');
const bencode = require('bencode');
const {Logged} = require('log');
const http = require('http');
const url = require('url2');
const {Class} = require('heritage');

const HttpTracker = Class({
    implements: [Logged],
    initialize: function(url) {
        this.url = url;
        this.announce = url.spec;
        this.tag = url.host;
    },
    ping: function(params, callback) {
        let existingParams = querystring.parse(this.url.query);
        for (name in existingParams) {
            params[name] = existingParams[name];
        }
        this.debug('base url: '+this.url.spec);
        let trackerUrl = url.URL(this.url.filePath + '?' + querystring.stringify(params), this.url);
        this.info('pinging tracker '+trackerUrl.spec);
        this.httpRequestHelper(trackerUrl, {}, 10, (function(error, response, body){
            if (!error) {
                try {
                    var result = bencode.decode(body);
                    this.debug('parsed tracker response');
                    callback(null, result);
                } catch (e) {
                    this.error('failed to parse tracker response: '+e);
                    callback(e);
                }
            } else {
                this.error('tracker responded with error: '+error);
                callback(error);
            }
        }).bind(this));
    },

    // callback(exception, response, body)
    // Handles redirects, coalescing response.

    httpRequestHelper: function(uri, headers, redirectLimit, callback){
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
                    callback(error, response, body);
                });
                response.on('end', function(){
                    callback(null, response, body);
                });
                response.on('data', function(chunk){
                    body += chunk;
                });
            } else {
                if (statusCode >= 300 && statusCode <= 399) {
                    if (redirectLimit <= 0) {
                        callback(new Error('too many redirects'), response);
                    }
                    else {
                        this.info('redirect ' + statusCode + ' ' + JSON.stringify(body));
                        httpRequestHelper(method, host, port, path, headers, redirectLimit - 1, callback);
                    }
                } else {
                    callback(new http.HttpError(statusCode), response, body);
                }
            }
        }).bind(this));
        request.end();
    }
});

exports.HttpTracker = HttpTracker;
