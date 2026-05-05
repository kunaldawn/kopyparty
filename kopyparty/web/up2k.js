"use strict";
// KD fork: upload manager removed — minimal no-op stub so browser.js's
// drag/drop / clipboard / search hooks don't ReferenceError when fired.

var J_U2K = 2;

var up2k = {
    uc: { ask_up: false, fsearch: false, multitask: 0, ow: false },
    gotallfiles: [function () {}],
    st: { files: [], todo: { handshake: [] }, busy: { handshake: [] } },
    ui: {
        seth: function () {},
        move: function () {},
        modn: function () {},
        modh: function () {},
    },
    set_fsearch: function () {},
    init_deps: function () {},
    flag_off: function () {},
    flag_on: function () {},
    bottle: function () {},
};

window.up2k = up2k;
