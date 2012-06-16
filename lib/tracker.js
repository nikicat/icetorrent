var http = require('http');
var bencode = require('bencode');
var url = require('url2');
var {escape} = require('log');
require('udpproto');

function toHexDigit(n){
    return '0123456789abcdef'[n];
}

function escapeBinary(s){
    // Node's querystring.stringify doesn't escape binary strings
    // correctly. (It inserts escape charcters. Not sure why, maybe
    // it is treating the data as UTF8 encoded or some other encoding.)
    var result = '', i, len, c, cc;
    s = '' + s;
    for (i = 0, len = s.length; i < len; i += 1) {
        c = s.charAt(i);
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c == '.' || c == '-' || c == '_' || c == '~')) {
            result += c;
        }
        else {
            cc = s.charCodeAt(i);
            result += '%' + toHexDigit(0xf & (cc >> 4)) + toHexDigit(0xf & cc);
        }
    }
    return result;
}

function queryStringify(params){
    var result = '', key, first = true;
    for (key in params) {
        if (params.hasOwnProperty(key)) {
            if (first) {
                first = false;
            }
            else {
                result += '&';
            }
            result += key + '=' + escapeBinary(params[key]);
        }
    }
    return result;
}

function create(metaInfo){
    var announce = metaInfo.announce;
    var announcelist = metaInfo['announce-list'];
    var parsedUrl = url.URL(announce);
    console.debug("parsed announce ("+announce+"): scheme="+parsedUrl.scheme+" hostname="+parsedUrl.host+" port="+parsedUrl.port+" pathname="+parsedUrl.path);
    var trackers = [{
        metaInfo: metaInfo,
        url: parsedUrl,
        peers: {}
    }];
    for (i in announcelist) {
        for (j in announcelist[i]) {
            var parsedUrl = url.URL(announcelist[i][j]);
            console.debug("parsed announce-list item ("+announcelist[i][j]+"): scheme="+parsedUrl.scheme+" hostname="+parsedUrl.host+" port="+parsedUrl.port+" pathname="+parsedUrl.path);
            trackers.push({
                metaInfo: metaInfo,
                url: parsedUrl,
                peers: {}
            });
        }
    }
    return trackers;
}

// callback(exception, response, body)
// Handles redirects, coalescing response.

function httpRequestHelper(uri, headers, redirectLimit, callback){
    var request = http.request({
        uri: uri,
        headers: headers,
        method: 'GET',
    });
    request.on('response', function(response){
        var statusCode = response.statusCode, body = '';
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
        }
        else 
            if (statusCode >= 300 && statusCode <= 399) {
                if (redirectLimit <= 0) {
                    callback('too many redirects', response);
                }
                else {
                    console.log('redirect ' + statusCode + ' ' + JSON.stringify(body));
                    httpRequestHelper(method, host, port, path, headers, redirectLimit - 1, callback);
                }
            }
            else {
                callback(new http.HttpError(statusCode), response, body);
            }
    });
    request.end();
}

// callback(error, {response})
function ping(trackerClient, params, callback){
    var existingParams = trackerClient.url.query.split('&');
    for (var i in existingParams) {
        var [name, value] = existingParams[i].split('=');
        params[name] = value;
    }
    var trackerUrl = url.URL(trackerClient.url.filePath + '?' + queryStringify(params), trackerClient.url);
    console.log('pinging tracker '+trackerUrl.spec);
    httpRequestHelper(trackerUrl, {}, 10, function(error, response, body){
        var result = {};
        console.debug("parsing tracker response "+escape(body));
        if (!error) {
            try {
                result = bencode.decode(body);
            } 
            catch (e) {
                error = e;
            }
        }
        callback(error, result);
    });
}

exports.create = create;
exports.ping = ping;
