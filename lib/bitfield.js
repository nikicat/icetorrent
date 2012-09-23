//var sortedArray = require('./sortedArray');
'use strict';

/*
 * n: number of bits, b: optional byte string,
 */
exports.create = function(n, bytes){
    if (n === 0 && bytes) {
        n = bytes.length / 8;
    }
    var byteLen = (n + 7) >> 3;
    var b = [];
    function stringToArray(bytes){
        var i;
        if (bytes) {
//            if (bytes.length != byteLen) {
//                throw "bad bytes length.";
//            }
            for (i = 0; i < bytes.length; i++) {
                b[i] = bytes.charCodeAt(i) & 0xff;
            }
        } else {
            for (i = 0; i < byteLen; i++) {
                b[i] = 0;
            }
        }
    };
    stringToArray(bytes);
    let ret = {
        set: function(index, val){
            if (!(index >= 0 /*&& index < n*/)) {
                throw new Error("bad index " + index);
            }
            if (index >= n) {
                let oldByteLen = byteLen;
                byteLen = (index + 8) >> 3;
                for (i = oldByteLen; i < byteLen; i++) {
                    b[i] = 0;
                }
                n = index+1;
            }
            let i = index >> 3;
            let m = 1 << ((~ index) & 7);
            let v = b[i];
            b[i] = v & (~ m) | (val ? m : 0);
        },
        get: function(index){
            if (!(index >= 0 && index < n)) {
                throw new Error("bad index " + index);
            }
            let i = index >> 3;
            let m = 1 << ((~ index) & 7);
            let v = b[i];
            return ((v & m) > 0) & 1;
        },
        setWire: function(bytes){
            stringToArray(bytes);
        },
        getWire: function(){
            let bytes = '', i;
            for (i = 0; i < byteLen; i++) {
                bytes += String.fromCharCode(b[i]);
            }
            return bytes;
        },
        getBitArray: function(){
            let r = [];
            for (let i = 0; i < n; i++) {
                r.push(ret.get(i));
            }
            return r;
        }
    };
    
    return ret;
};
