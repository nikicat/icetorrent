'use strict';

const Iterator = require('window-utils').activeBrowserWindow.Iterator;
const {Logged} = require('./log');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const cryptolib = require('./crypto');
const {Class} = require('heritage');
const fs = require('./fs');
const timers = require('timers');

function toHexString(charCode) {  
    return ("0" + charCode.toString(16)).slice(-2);  
}

function hashToHexString(hash) {
    return [toHexString(hash.charCodeAt(i)) for (i in hash)].join("");
}

const Piece = Class({
    implements: [Logged, EventTarget],
    name: 'Piece',
    initialize: function(store, index, hash, length) {
        this.store = store;
        this.index = index;
        this.hash = hash;
        this.good = false;
        this.tag = index;
        this.length = length;
        this.offset = index * store.pieceLength;
        this.downloading = {};
        this.files = [];
    },

    addFile: function(file) {
        this.files.push(file);
    },

    inspect: function() {
        let hash = new cryptolib.Hash('sha1');
        for each (let data in this.read()) {
            this.debug('updating hash with data ('+data.length+' bytes)');
            hash.update(data);
        }
        let digest = hash.digest('binary');
        this.debug('digest: '+hashToHexString(digest)+" expected: "+hashToHexString(this.hash));
        this.good = this.hash === digest;
        
        if (this.good) {
            emit(this.store, 'havepiece', this);
        } else {
            emit(this.store, 'needpiece', this);
        }
    },

    read: function() {
        for each (let file in this.files) {
            let [offset,size] = file.getIntersection(this);
            this.debug('reading from file ('+offset+'; '+size+')');
            file.fd.seek(offset);
            yield file.fd.read(size);
        }
    },
 
    addFragment: function(offset, data) {
        let length = data.length;
        if (!((offset >= 0 && offset + length <= this.length) &&
            (length > 0 && length <= 32 * 1024))) {
            this.error('could not add piece fragment: offset='+offset+' length='+length);
            throw new Error('bad piece fragment');
        }
        this.debug('received piece fragment '+offset+' '+length);
        
        this.downloading[offset] = true;

        this.writeFragment(offset, data);
        this.debug('wrote fragment ['+offset+';'+(offset+data.length)+']'); // Reduced verbosity.
        
        let hasdone = 0;                
        for each (let z in this.downloading)
            hasdone += z;
       
        // HACK: this condition may be false-positive
        if (hasdone === Math.ceil(this.length/data.length)) {
            this.inspect();
        } else {
            this.debug('not done yet')
        }
    },

    writeFragment: function(offset, data) {
        for each (let file in this.files) {
            let [fileOffset, fileSize] = file.getIntersection({
                offset: this.offset + offset,
                length: data.length
            });
            if (fileOffset === 0 && fileSize === 0) {
                continue;
            }
            let frag = data.substring(0, fileSize);
            file.fd.seek(fileOffset);
            file.fd.write(frag);
            data = data.substring(fileSize);
        }
    }
});

exports.Piece = Piece;
