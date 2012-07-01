var sortedArray = require('./sortedArray');

/*
 * n: number of bits, b: optional byte string,
 */
exports.create = function(n, bytes){
    var byteLen = (n + 7) >> 3, b = [];
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
    var ret = {
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
            }
            var i = index >> 3, m = 1 << ((~ index) & 7), v = b[i];
            b[i] = v & (~ m) | (val ? m : 0);
        },
        get: function(index){
            if (!(index >= 0 && index < n)) {
                throw new Error("bad index " + index);
            }
            var i = index >> 3, m = 1 << ((~ index) & 7), v = b[i];
            return (v & m) != 0;
        },
        setWire: function(bytes){
            stringToArray(bytes);
        },
        getWire: function(){
            var bytes = '', i;
            for (i = 0; i < byteLen; i++) {
                bytes += String.fromCharCode(b[i]);
            }
            return bytes;
        },
        getBitArray: function(){
            for (var i = 0, r = []; i < n; i++) {
                r.push(ret.get(i));
            }
            return r;
        }
    };
    
    return ret;
};
