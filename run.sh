#!/bin/bash
set -m
if [ "$1" = '-d' ]; then
    binary=/usr/bin/firefox-nightly-debug
    shift
else
    binary=/usr/bin/firefox-nightly
fi
cmd="cfx run -p profile --package-path=/usr/lib/node_modules/ -b $binary $@"
if [ "$1" = '-v' ]; then
    NSPR_LOG_MODULES=all:5 $cmd >output.log 2>&1 &
else
    $cmd >output.log 2>&1 &
fi
pid=$!
less output.log
kill -INT $pid
