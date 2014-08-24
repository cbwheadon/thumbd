var aws = require('aws-sdk'),
	_ = require('underscore'),
	config = require('./config').Config,
	Grabber = require('./grabber').Grabber,
	Thumbnailer = require('./thumbnailer').Thumbnailer,
	Saver = require('./saver').Saver,
	fs = require('fs'),
	request = require('request'),
	async = require('async');

/**
 * Initialize the Worker
 *
 * @param object opts Worker configuration. Optional.
 */
function Worker(opts) {
	_.extend(this, {
		thumbnailer: null,
		grabber: null,
		saver: null
	}, opts);

	this.sqs = new aws.SQS({
		accessKeyId: config.get('awsKey'),
		secretAccessKey: config.get('awsSecret'),
		region: config.get('awsRegion')
	});

	config.set('sqsQueueUrl', this.sqs.endpoint.protocol + '//' + this.sqs.endpoint.hostname + '/' + config.get('sqsQueue'));

	config.set('sqsReplyUrl', this.sqs.endpoint.protocol + '//' + this.sqs.endpoint.hostname + '/' + config.get('sqsReply'));

}

Worker.prototype._reenqueueProcessMessage = (function() {
	var _this = this;
	process.nextTick(function() {
		_this._processSQSMessage();
	});
});

/**
 * Start the worker
 */
Worker.prototype.start = function() {
	this._processSQSMessage();
};

/**
 * Process the next message in the queue
 */
Worker.prototype._processSQSMessage = function() {
	var _this = this;

	console.log('wait for message on ' + config.get('sqsQueue') + ' ' + Date.now());

	this.sqs.receiveMessage( { QueueUrl: config.get('sqsQueueUrl'), MaxNumberOfMessages: 1 }, function (err, job) {
		if (err) {
			console.log(err);
			_this._reenqueueProcessMessage();
			return;
		}

		if (!job.Messages || job.Messages.length === 0) {
			_this._reenqueueProcessMessage();
			return;
		}

		// Handle the message we pulled off the queue.
		var handle = job.Messages[0].ReceiptHandle,
			body = null;

		try { // a JSON string message body is accepted.
			body = JSON.parse( job.Messages[0].Body );
		} catch(e) {
			if (e instanceof SyntaxError) {
				// a Base64 encoded JSON string message body is also accepted.
				body = JSON.parse( new Buffer(job.Messages[0].Body, 'base64').toString( 'binary' ) );
			} else {
				// TODO: figure out if throwing is actually
				// the right thing to do here.
				throw e;
			}
		}

		_this._runJob(handle, body, function() {
		_this._reenqueueProcessMessage();
		});
	});
};

/**
 * Process a job from the queue
 *
 * @param string handle The SQS message handle
 * @param object job The job parameters
 * @param function callback The callback function
 */
Worker.prototype._runJob = function(handle, job, callback) {
	/**
		job = {
			"original": "/foo/awesome.jpg",
			"descriptions": [{
				"suffix": "small",
				"width": 64,
				"height": 64
			}],
		}
	*/
	var _this = this;

	this._downloadFromS3(job.bucket, job.region, job.original, function(err, localPath) {

		if (err) {
			console.log(err);
			callback();
			return;
		}

		_this._createThumbnails(localPath, job, function(err) {
			fs.unlink(localPath, function() {
				if (!err) {
					_this._deleteJob(handle);
				}
				callback();
			});
		});

	});
};


/**
 * Download the image from S3
 *
 * @param string remoteImagePath The s3 path to the image
 * @param function callback The callback function
 */
Worker.prototype._downloadFromS3 = function(bucket, region, remoteImagePath, callback) {
	// allow a default bucket to be overridden.
	var bucket = bucket || config.get('s3Bucket'),
		region = region || config.get('awsRegion');

	this.grabber.download(bucket, region, remoteImagePath, function(err, localPath) {
		// Leave the job in the queue if an error occurs.
		if (err) {
			callback(err);
			return;
		}

		callback(null, localPath);
	});
};

/**
 * Create thumbnails for the image
 *
 * @param string localPath The local path to store the images
 * @param object job The job description
 * @param function callback The callback function
 */
Worker.prototype._createThumbnails = function(localPaths, job, callback) {
	console.log('creat thumbs',localPaths);
	var _this = this,
		work = [],
		bucket = job.bucket || config.get('s3Bucket'),
		region = job.region || config.get('awsRegion');

		work.push(function(done) {

			var remoteImagePath = job.destination,
				thumbnailer = new Thumbnailer();

			thumbnailer.execute(job, localPaths, function(err, convertedImagePath) {

				if (err) {
					done();
				} else {
					_this._saveThumbnailToS3(bucket, region, convertedImagePath, remoteImagePath);
						_this._decodeQR(convertedImagePath, _this.files);
						console.log('retrieved qr code', _this.qrcode);
						console.log('convertedImagePath', convertedImagePath, _this.files);
						_this._sendReply(job.id, job.queue ,_this.files,_this.qrcode);
						done(null, remoteImagePath);
					}
				});
		});
	// perform thumbnailing in parallel.
	async.parallel(work, callback);
};

/** Decode QR **/
Worker.prototype._decodeQR=function(dirname, files) {
    var _this = this;
  var Canvas = require('canvas')
      , Image = Canvas.Image
      , qrcode = require('jsqrcode')(Canvas)

    var filename = dirname + '/0.png';
    var image = new Image()
    image.onload = function(){
      var result;
      try{
        result = qrcode.decode(image);
        console.log('result of qr code: ' + result);
	_this.qrcode = result;
      } catch(e){
        console.log('unable to read qr code',e);
	_this.qrcode = '';
      }
    }
    image.src = filename;
}
/**
 * Reply
 *
 * @param string files The converted image paths
 */
Worker.prototype._sendReply = function(id, queue, files, qrcode){
		console.log("sending reply id: ",id, " queue:", queue, " files:" ,files, "qrcode", qrcode);
		config.set('sqsReplyUrl', this.sqs.endpoint.protocol + '//' + this.sqs.endpoint.hostname + '/' + queue + '_' + config.get('sqsReply'));
    this.sqs.sendMessage({QueueUrl: config.get('sqsReplyUrl'), MessageBody: JSON.stringify({
			id: id,
			files: files,
			qrcode: qrcode
    })}, function (err, result) {
			console.log(err,result);
    });
};


/**
 * Save the thumbnail to S3
 *
 * @param string convertedImagePath The local path to the image
 * @param string remoteImagePath The S3 path for the image
 * @param function callback The callback function
 */
Worker.prototype._saveThumbnailToS3 = function(bucket, region, convertedImagePath, remoteImagePath, callback) {
    //Save each file in the folder
    //this.saver.save(convertedImagePath + '/0.png', remoteImagePath);
    var _this = this;
    files = fs.readdirSync(convertedImagePath);
    console.log('files: ',files);
    _this.files = files;
    fn = remoteImagePath.replace(/\.[^/.]+$/, "");
    for(i =0; i < files.length; i++){
	    convertedFilePath = convertedImagePath + '/' + files[i];
	    remoteFilePath = fn + '.' + files[i];
	    _this.saver.save(bucket, region, convertedFilePath, remoteFilePath, function(err){
	    //fs.unlinkSync(convertedFilePath);
	    });
    }
    //fs.rmdirSync(convertedImagePath);
};

/**
 * Generate a path for this thumbnail
 *
 * @param string original The original image path
 * @param string suffix The thumbnail suffix. e.g. "small"
 * @param string format The thumbnail format. e.g. "jpg". Optional.
 */
Worker.prototype._thumbnailKey = function(original, suffix, format) {
	var extension = original.split('.').pop(),
		prefix = original.split('.').slice(0, -1).join('.');

	return prefix + '_' + suffix + '.' + (format || 'png');
};

/**
 * Remove a job from the queue
 *
 * @param string handle The SQS message handle
 */
Worker.prototype._deleteJob = function(handle) {
	this.sqs.deleteMessage({QueueUrl: config.get('sqsQueueUrl'), ReceiptHandle: handle}, function(err, resp) {
		if (err) {
			console.log("error deleting thumbnail job " + handle, err);
			return;
		}
		console.log('deleted thumbnail job ' + handle);
	});
};

/**
 * Call notification url
 *
 * @param string job: the body of the SQS job.
 */
Worker.prototype._notify = function(job, cb) {
  if (!job.notify) return cb();

	var options = {
		method: "POST",
		url: job.notify,
		json: true,
		body: job
	}

	request.post(options, function(err) {
		if (!err) {
			console.log('notified:', job.notify);
		}
		return cb();
	});
}

exports.Worker = Worker;
