'use strict';

const fs = require('./fs');
const filepath = require('file');
const {Logged} = require('./log');
const {Class} = require('heritage');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');

const File = Class({
    implements: [Logged, EventTarget],
    initialize: function(store, info, file, offset) {
        this.store = store;
        this.tag = file.path[file.path.length-1];
        this.path = filepath.join.apply(null, [this.store.path].concat(file.path));
        this.name = filepath.basename(this.path);
        this.offset = offset;
        this.length = file.length;
        this.md5sum = file.md5sum;
        this.notified = 0;
        this.wanted = false;
        this.store.on('havepiece', (function(piece) {
            if (this.pieces.indexOf(piece) !== -1) {
                this.debug('received piece '+piece.index);
                emit(this, 'havepiece', piece);
                this.notify();
            }
        }).bind(this));
        this.debug('initialized. name: '+this.name+'; path: '+this.path+'; offset: '+this.offset+'; length: '+this.length+'; md5sum: '+this.md5sum);
    },

    get bytesCompleted () {
        let result = 0;
        for each (let piece in this.pieces) {
            if (piece.good) {
                let [offset,size] = this.getIntersection(piece);
                result += size;
            }
        }
        return result;
    },

    getIntersection: function(piece) {
        let begin = Math.max(piece.offset - this.offset, 0);
        let end = Math.min(piece.offset + piece.length - this.offset, this.length);
        return [begin, Math.max(end-begin, 0)];
    },

    notify: function() {
        for each (let piece in this.pieces.slice(this.notified)) {
            if (piece.good) {
                let [offset,size] = this.getIntersection(piece);
                this.fd.seek(offset);
                let data = this.fd.read(size);
                emit(this, 'data', data);
                this.notified++;
            } else {
                break;
            }
        }
        if (this.notified === this.pieces.length) {
            emit(this, 'end');
        }
    },

    getPieceForOffset: function(offset) {
        return this.store.pieces[Math.floor(offset / this.store.pieceLength)];
    },

    get pieces () {
        let res = [];
        let begin = this.getPieceForOffset(this.offset);
        let end = this.getPieceForOffset(this.offset + this.length - 1);
        for (let i=begin.index; i<=end.index; i++) {
            res.push(this.store.pieces[i]);
        }
        return res;
    },

    getNeededPieces: function() {
        let needed = [];
        for each (let piece in this.pieces) {
            if (!piece.good) {
                needed.push(piece);
            }
        }
        return needed;
    },

    initFd: function() {
        let mode = 6 * 64 + 4 * 8 + 4; // 0666 aka rw-rw-rw-
        let stats = fs.Stats(this.path);
        if (stats.exists) {
            if (!stats.isDirectory && stats.size === this.length) {
                // file exists, and is right length and type
                this._fd = stats.open('r+', mode);
                return;
            } else {
                stats.unlink();
            }
        }
        this._fd = stats.open('w+', mode);
        this._fd.truncate(this.length);
    },

    //Calls callback(err, file)
    get fd () {
        if (!this._fd) {
            this.initFd();
        }
        return this._fd;
    }

});

exports.File = File;
