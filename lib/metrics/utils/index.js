'use strict';

const nameCache = new Map();

function normalizeName(name) {
    // See https://github.com/etsy/statsd/issues/110
    // Only [\w_.-] allowed, with '.' being the hierarchy separator.
    let res = nameCache.get(name);
    if (res === undefined) {
        res = name.replace(/[^/a-zA-Z0-9.-]/g, '-').replace(/\//g, '_');
        nameCache.set(name, res);
    }
    return res;
}

// Flattens labels with their names
function zipLabels(options, labels) {
    if (options.labels.omitLabelNames) {
        return labels;
    }
    const output = [];
    for (let i = 0; i < labels.length; i++) {
        output.push(options.labels.names[i]);
        output.push(labels[i] || undefined);
    }
    return output;
}

// Formats label set with metric name
function formatLabels(options, labels) {
    let formattedLabels = [...labels];
    if (options.labels.names) {
        formattedLabels = zipLabels(options, formattedLabels);
    }
    if (options.labels.labelPosition === 'before') {
        formattedLabels.push(options.name);
    } else {
        formattedLabels.unshift(options.name);
    }
    return formattedLabels;
}

module.exports.normalizeName = normalizeName;
module.exports.formatLabels = formatLabels;
