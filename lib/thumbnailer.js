var exec = require('child_process').exec,
	sprintf = require('sprintf-js').sprintf,
	_ = require('underscore'),
	fs = require('fs'),
	config = require('./config').Config;

/**
 * Initialize the Thumbnailer
 */
function Thumbnailer(opts) {
	// for the benefit of testing
	// perform dependency injection.
	_.extend(this, {
		tmp: require('tmp')
	}, opts);
}

/**
 * Execute the image conversion command
 *
 * @param object description The job description
 * @param localPath The local path to the image
 * @param function onComplete The callback function
 */
Thumbnailer.prototype.execute = function(description, localPaths, onComplete) {
	var _this = this;

	// Convert single path to array
	if (!_.isArray(localPaths)) {
		localPaths = [localPaths];
	}

	// parameters for a single execution
	// of the thumbnailer.
	_.extend(this, {
		localPaths: localPaths,
		width: description.width,
		height: description.height,
		format: (description.format || 'png'),
		strategy: (description.strategy || 'pdf'),
		background: (description.background || 'black'),
		quality: (description.quality || 0),
		command: (description.command || config.get('convertCommand')),
		onComplete: onComplete,
		thumbnailTimeout: 20000
	});

	this.createConversionPath(function(err) {

		if (err) {
			_this.onComplete(err);
			return;
		}

		// apply the thumbnail creation strategy.
		if (!_this[_this.strategy]) {
			_this.onComplete('could not find strategy ' + _this.strategy);
		} else {
			_this[_this.strategy]();
		}
	});
};

/**
 * Choose an appropriate image manipulation
 * strategy, based on 'strategy' key in job.
 * If the strategy contains, %(command)s, assume
 * manual strategy:
 *
 * "%(command)s -border 0 -tile 3x1 -geometry 160x106 "%(localPaths[0])s" "%(localPaths[1])s" "%(localPaths[2])s" -quality 90 %(convertedPath)s"
 *
 * @return string strategy to execute.
 * @throw strategy not found.
 */
Thumbnailer.prototype._guessStrategy = function() {
	if (this.strategy.match(/%\(.*\)s/)) {
		return 'manual'
	} else if (!this[this.strategy]) {
		this.onComplete(Error('could not find strategy ' + this.strategy));
	} else {
		return this.strategy;
	}
}

/**
 * Create a temp file for the converted image
 *
 * @param function callback The callback function
 */
Thumbnailer.prototype.createConversionPath = function(callback) {
    var _this = this;
		console.log('tmpDir',config.get('tmpDir'))
    this.tmp.dir({prefix: config.get('tmpDir')}, function(err, convertedPath) {
	//fs.closeSync(fd); // close immediately, we do not use this file handle.
	_this.convertedPath = convertedPath;
	callback(err);
    });
};

/**
 * Execute the conversion command
 *
 * @param string command The command
 */
Thumbnailer.prototype.execCommand = function(command) {
	var _this = this;

	exec(command, {timeout: this.thumbnailTimeout}, function(err, stdout, stderr) {

		console.log('running command ', command);

		if (err) {
			_this.onComplete(err);
			return;
		}
	    console.log('path', _this.convertedPath);
	    fs.readdir(_this.convertedPath, function(err,files){
		if(err || files.length === 0){
		    err = 'No files created';
		    _this.onComplete(err);
		    return;
		}
		_this.onComplete(null, _this.convertedPath);
	    })
	});
};

/**
 * Convert the image using the manual strategy.
 * looks for a strategy of the form:
 *
 * "%(command)s -border 0 -tile 3x1 -geometry 160x106 '%(localPath[0])s' '%(localPath[1])s' '%(localPath[2])s' -quality 90 %(convertedPath)s
 *
 * The custom strategy has access to all variables set on
 * the thumbnailer instance:
 *   * command: the conversion command to run.
 *   * localPaths: the local temp images to apply operation to.
 *   * convertedPath: path to store final thumbnail to on S3.
 */
Thumbnailer.prototype.manual = function() {
	try {
		var thumbnailCommand = sprintf(this.strategy, this);
	} catch (err) {
		this.onComplete(err);
	}

	this.execCommand(thumbnailCommand);
};

/** Convert a pdf
*/
Thumbnailer.prototype.pdf = function() {
	//var thumbnailCommand = 'convert -colorspace Gray -density 200 ' + this.localPaths[0] + ' -depth 8 ' + this.convertedPath + '/%d.png';
	var thumbnailCommand = 'convert -fuzz 20% -transparent none -density 200 -trim ' + this.localPaths[0] + ' -depth 8 ' + this.convertedPath + '/%d.png';
	this.execCommand(thumbnailCommand);
};

/**
 * Convert the image using the matted strategy
 */
Thumbnailer.prototype.matted = function() {
	var dimensionsString = this.width + 'X' + this.height,
	  qualityString = (this.quality ? '-quality ' + this.quality : ''),
		thumbnailCommand = config.get('convertCommand') + ' "' + this.localPaths[0] + '[0]" -resize ' + dimensionsString + ' -size ' + dimensionsString + ' xc:' + this.background + ' +swap -gravity center' + qualityString + ' -composite ' + this.convertedPath;
	this.execCommand(thumbnailCommand);
};

/**
 * Convert the image using the bounded strategy
 */
Thumbnailer.prototype.bounded = function() {
	var dimensionsString = this.width + 'X' + this.height,
		qualityString = (this.quality ? '-quality ' + this.quality + ' ' : ''),
		thumbnailCommand = config.get('convertCommand') + ' "' + this.localPaths[0] + '[0]" -thumbnail ' + dimensionsString + ' ' + qualityString + this.convertedPath;

	this.execCommand(thumbnailCommand);
};

/**
 * Convert the image using the fill strategy
 */
Thumbnailer.prototype.fill = function() {
	var dimensionsString = this.width + 'X' + this.height,
		qualityString = (this.quality ? '-quality ' + this.quality : ''),
		thumbnailCommand = config.get('convertCommand') + ' "' + this.localPaths[0] + '[0]" -resize ' + dimensionsString + '^ -gravity center -extent ' + dimensionsString + ' ' + qualityString + ' ' + this.convertedPath;

	this.execCommand(thumbnailCommand);
};

/**
 * Convert the image using the strict strategy
 */
Thumbnailer.prototype.strict = function() {
	var dimensionsString = this.width + 'X' + this.height,
		qualityString = (this.quality ? '-quality ' + this.quality : ''),
		thumbnailCommand = config.get('convertCommand') + ' "' + this.localPaths[0] + '[0]" -resize ' + dimensionsString + '! ' + qualityString + ' ' + this.convertedPath;

	this.execCommand(thumbnailCommand);
};

exports.Thumbnailer = Thumbnailer;
