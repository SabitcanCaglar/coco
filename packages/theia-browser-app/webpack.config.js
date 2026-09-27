/**
 * This file can be edited to customize webpack configuration.
 * To reset delete this file and rerun theia build again.
 */
// @ts-check
const configs = require('./gen-webpack.config.js');
const nodeConfig = require('./gen-webpack.node.config.js');
const path = require('path');

nodeConfig.config.plugins = nodeConfig.config.plugins.filter(
    plugin => plugin !== nodeConfig.nativePlugin
);
delete nodeConfig.config.entry['worker/conoutSocketWorker'];
delete configs[0].entry['editor.worker'];
nodeConfig.config.resolve = {
    ...nodeConfig.config.resolve,
    alias: {
        ...(nodeConfig.config.resolve?.alias ?? {}),
        drivelist: path.resolve(__dirname, 'drivelist-stub.js'),
        keytar: false,
        '@theia/process/lib/common/process-common-module': false,
        '@theia/process/lib/node/process-backend-module': false,
        '@theia/file-search/lib/node/file-search-backend-module': false,
        '@theia/terminal/lib/node/terminal-backend-module': false
    }
};

/**
 * Expose bundled modules on window.theia.moduleName namespace, e.g.
 * window['theia']['@theia/core/lib/common/uri'].
 * Such syntax can be used by external code, for instance, for testing.
configs[0].module.rules.push({
    test: /\.js$/,
    loader: require.resolve('@theia/application-manager/lib/expose-loader')
}); */

module.exports = [
    ...configs,
    nodeConfig.config
];
