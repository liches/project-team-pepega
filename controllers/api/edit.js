const express = require("express");
const router = express.Router();
const {auth} = require("../../middleware/auth");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("../../controllers/ff_path");
// Item model
const Item = require("../../models/Item");
const mongoose = require("mongoose");
// import stream from 'stream';
//const { gfs_prim } = require("../../middleware/gridSet");
const { gfs_prim, upload } = require("../../middleware/gridSet");
// const storage = multer.diskStorage({
//   destination: path.join(__dirname, "../../video_input/"),
//   filename: function (req, file, callback) {
//     callback(null, "recording.mp3")
//   }
// });
//const upload = multer({ dest: path.join(__dirname, "../../recordings/") });
const crypto = require("crypto");
const validator = require('validator');

/**
 * sanitize the given file name,
 * if the filename is not given, randomly generate one
 * @param {*} req 
 * @param {*} res 
 * @param {*} next 
 */
function sanitizeFilename(req, res, next) {
  if (req.body.filename) {
    req.body.filename = validator.escape(req.body.filename);
  } else {
    req.body.filename = crypto.randomBytes(16).toString("hex");
  }
  next();
}

/**
 * Get the read stream of the id entry from the gridf
 * @param {*} id 
 * @param {*} gfs 
 */
function retrievePromise(id, gfs) {
  return new Promise(function (resolve, reject) {
    gfs.files.findOne({ _id: mongoose.Types.ObjectId(id) }, (err, file) => {
      // Check if file
      if (!file || file.length === 0) {
        return reject("fail fetch", id);
      }
      const readstream = gfs.createReadStream(file._id);
      return resolve(readstream);
    });
  });
}
/**
 * Generate Thumbnail for the given file
 * @param {*} id 
 * @param {*} filename 
 */
function generateThumbnail(id, filename) {
  return new Promise(function (resolve, reject) {
    gfs_prim.then(function (gfs) {
      let basename = path.basename(filename).replace(path.extname(filename), ""); //filename w/o extension
      const fname = basename + ".png";
      let result = gfs.createWriteStream({
        filename: fname,
        mode: "w",
        content_type: "image/png",
        metadata: { video_id: id }
      });
      //search for newly generated video every 0.5s until exists since this gridfs version has a small delay on write
      let idInterval = setInterval(function () {
        retrievePromise(id, gfs).then(function (item) {
          clearInterval(idInterval);
          ffmpeg(item)
            .withVideoCodec("png")
            .addOptions([
              "-vframes 1", //output 1 frame
              "-f image2pipe" //force image to writestream
            ])
            .on("progress", progress => {
              console.log(`[Thumbnail]: ${JSON.stringify(progress)}`);
            })
            .on("stderr", function (stderrLine) {
              console.log("Stderr output [Thumbnail]: " + stderrLine);
            })
            .on("error", function (err) {
              return reject("An error occurred [Thumbnail]: ", err.message);
            })
            .on("end", function () {
              return resolve("Thumbnail is completed");
            })
            .saveToFile(result);
        });
      }, 500);
    });
  });
}

// @route  POST /api/caption
// @desc   Create caption for the selected video
// @access Private
router.post("/caption/:id", auth, sanitizeFilename,  (req, res) => {
  res.set("Content-Type", "text/plain");
  // check if request has valid data
  if (!req.body.data) {
    return res.status(400).end("Bad argument: Missing data");
  }
  // check if request has valid uploader id
  if (!req.body.uploader_id) {
    return res.status(400).end("Bad argument: Missing data");
  }
  // check if the filename already exist

  // start write the content of subtitle caption 
  let result = "";
  req.body.data.forEach(function (curr, index) {
    let temp = "" + (index + 1) + "\n";
    temp += curr.start_time + " --> " + curr.end_time + "\n";
    temp += curr.text + "\n";
    result += temp;
  });
  const fname = req.body.filename + ".webm";
  // sub_path
  let sub_path = path
    .join(__dirname, "/../../temp/subtitle/", req.body.filename + "t_sub.srt")
    .replace(/\\/g, "\\\\\\\\")
    .replace(":", "\\\\:");
  // Note: we need to change this, it doesn't allow 
  let srt_path = __dirname + "/../../temp/subtitle/" + req.body.filename + "t_sub.srt";
  console.log(srt_path);
  console.log(sub_path);
  fs.writeFile(srt_path, result, function (err) {
    if (err) throw err;
    console.log("Saved!");
    gfs_prim.then(function (gfs) {
      // get read stream from DB
      let resultFile = gfs.createWriteStream({
        filename: fname,
        mode: "w",
        content_type: "video/webm",
        metadata: {
          uploader_id: req.body.uploader_id,
          originalname: fname
        }
      });
      let currentItem = retrievePromise(req.params.id, gfs);
      let currentItemCopy = retrievePromise(req.params.id, gfs);
      Promise.all([currentItem, currentItemCopy]).then(Items => {
        let currStream = Items[0];
        let readItem = Items[1];
        ffmpeg.ffprobe(currStream, function (err, metadata) {
          let width = metadata ? metadata.streams[0].width : 640;
          let height = metadata ? metadata.streams[0].height : 360;
          let fps = metadata ? metadata.streams[0].r_frame_rate : 30;
          let duration = metadata ? metadata.format.duration : 5;
          console.log(width);
          console.log(height);
          console.log(fps);
          console.log(duration);
          // adding caption
          ffmpeg()
            .input(readItem)
            .format("webm")
            .withVideoCodec("libvpx")
            .addOptions(["-b:v 0", "-crf 30"])
            .withVideoBitrate(1024)
            .withAudioCodec("libvorbis")
            .withFpsInput(fps)
            .outputOptions([
              `-vf scale=${width}:${height},setsar=1`,
              `-vf subtitles=${sub_path}`
            ])
            .outputOption(["-metadata", `duration=${duration}`])
            .on("progress", progress => {
              console.log(`[Caption]: ${JSON.stringify(progress)}`);
            })
            .on("error", function (err) {
              fs.unlink(srt_path, err => {
                if (err) console.log("Could not remove srt file:" + err);
              });
              return res
                .status(500)
                .json("An error occurred [Caption]: " + err.message);
            })
            .on("stderr", function (stderrLine) {
              console.log("Stderr output [Subtitle]:: " + stderrLine);
            })
            .on("end", function () {
              fs.unlink(srt_path, err => {
                if (err) console.log("Could not remove srt file:" + err);
              });
              // TODO return data with path to access the file in the database
              generateThumbnail(resultFile.id, fname)
              .then(() => {
                return res.status(200).json("Caption is added");
              })
              .catch((err) => {
                return res.status(202).json("Caption is added: ", err)
              });
            })
            .writeToStream(resultFile);
        });
      });
    });
  });
});

// @route  POST /api/edit/merge/
// @desc   Append video from idMerge to video from id
// @access Private
router.post("/merge/:id", auth, sanitizeFilename, (req, res) => {
  res.set("Content-Type", "text/plain");
  console.log(req.params.id)
  console.log(req.body.merge_vid_id)
  if (!req.params.id || !req.body.merge_vid_id)
    return res.status(400).end("video id for merging required");

  gfs_prim.then(function (gfs) {
    let itemOne = retrievePromise(req.params.id, gfs);
    let itemOneCopy = retrievePromise(req.params.id, gfs);
    let itemTwo = retrievePromise(req.body.merge_vid_id, gfs);
    let itemTwoCopy = retrievePromise(req.body.merge_vid_id, gfs);
    const fname = req.body.filename + ".webm";
    let result = gfs.createWriteStream({
      filename: fname,
      mode: "w",
      content_type: "video/webm",
      metadata: {
        uploader_id: req.body.uploader_id,
        originalname: fname
      }
    });
    Promise.all([itemOne, itemOneCopy, itemTwo, itemTwoCopy]).then(function (itm) {
      let currStream = itm[0];
      let currStreamCopy = itm[1];
      let targetStream = itm[2];
      let targetStreamCopy = itm[3];
      let path1 = path.join(__dirname, "../../video_input/test1.mp4");
      let path2 = path.join(__dirname, "../../video_input/test2.mp4");
      let path1_base = path.basename(path1).replace(path.extname(path1), ""); //filename w/o extension
      let path2_base = path.basename(path2).replace(path.extname(path2), "");
      let path1_tmp = path.join(path.dirname(path1), path1_base + "_mod1.webm"); //temp file loc
      let path2_tmp = path.join(path.dirname(path2), path2_base + "_mod2.webm");
      let pathOut_tmp = path.join(__dirname, "../../video_output/tmp");

      let width, height, fps, duration_one, duration_two;
      ffmpeg.ffprobe(targetStream, function (err, metadata_two) {
        duration_two = metadata_two ? metadata_two.format.duration : 5;
        ffmpeg.ffprobe(currStream, function (err, metadata) {
          width = metadata ? metadata.streams[0].width : 640;
          height = metadata ? metadata.streams[0].height : 360;
          fps = metadata ? metadata.streams[0].r_frame_rate : 30;
          duration_one = metadata ? metadata.format.duration : 5;

          console.log(metadata);
          console.log(metadata_two);

          console.log("d1: ", duration_one);
          console.log("d2: ", duration_two);
          ffmpeg(currStreamCopy)
            .format("webm")
            .withVideoCodec("libvpx")
            //.addOptions(["-qmin 0", "-qmax 50", "-crf 5"])
            .addOptions(["-b:v 0", "-crf 30"])
            .withVideoBitrate(1024)
            .withAudioCodec("libvorbis")
            .withFpsInput(fps)
            .outputOptions([`-vf scale=${width}:${height},setsar=1`]) //Sample Aspect Ratio = 1.0     
            .on("progress", progress => {
              console.log(`[Merge1]: ${JSON.stringify(progress)}`);
            })
            .on("error", function (err) {
              res.json("An error occurred [Merge1]: " + err.message);
            })
            .on('stderr', function (stderrLine) {
              console.log('Stderr output [Merge1]: ' + stderrLine);
            })
            .on("end", function () {
              ffmpeg(targetStreamCopy)
                .format("webm")
                .withVideoCodec("libvpx")
                .addOptions(["-b:v 0", "-crf 30"]) //sets bitrate to zero and specify Constant Rate Factor to target certain perceptual quality lvl, prevents quality loss
                .withVideoBitrate(1024)
                .withAudioCodec("libvorbis")
                .withFpsInput(fps)
                .outputOptions([`-vf scale=${width}:${height},setsar=1`])
                .on("progress", progress => {
                  console.log(`[Merge2]: ${JSON.stringify(progress)}`);
                })
                .on("error", function (err) {
                  fs.unlink(path1_tmp, err => {
                    if (err)
                      console.log("Could not remove Merge1 tmp file:" + err);
                  });
                  return res.json("An error occurred [Merge2]: " + err.message);
                })
                .on('stderr', function (stderrLine) {
                  console.log('Stderr output [Merge2]:: ' + stderrLine);
                })
                .on("end", function () {
                  ffmpeg({ source: path1_tmp })
                    .mergeAdd(path2_tmp)
                    .addOutputOption(["-b:v 0", "-crf 30", "-f webm"])
                    .outputOption(["-metadata", `duration=${duration_one + duration_two}`])
                    .on("progress", progress => {
                      console.log(`[MergeCombine]: ${JSON.stringify(progress)}`);
                    })
                    .on("error", function (err) {
                      fs.unlink(path1_tmp, err => {
                        if (err)
                          console.log("Could not remove Merge1 tmp file:" + err);
                      });
                      fs.unlink(path2_tmp, err => {
                        if (err)
                          console.log("Could not remove Merge2 tmp file:" + err);
                      });
                      return res.json("An error occurred [MergeCombine]: " + err.message);
                    })
                    .on('stderr', function (stderrLine) {
                      console.log('Stderr output [MergeCombine]:: ' + stderrLine);
                    })
                    .on("end", function () {
                      fs.unlink(path1_tmp, err => {
                        if (err)
                          console.log("Could not remove Merge1 tmp file:" + err);
                      });
                      fs.unlink(path2_tmp, err => {
                        if (err)
                          console.log("Could not remove Merge2 tmp file:" + err);
                      });
                      generateThumbnail(result.id, fname)
                      .then(() => {
                        return res.status(200).json("Merging is completed");
                      })
                      .catch((err) => {
                        return res.status(202).json("Merging is completed: ", err)
                      });
                    })
                    .mergeToFile(result, pathOut_tmp);
                })
                .save(path2_tmp);
            })
            .save(path1_tmp);
        });
      });
    });
  });
});

// @route  POST /api/edit/cut/:id/
// @desc   Cut video section at timestampOld of video from id and move to timestampNew
// @access Private
router.post("/cut/:id", sanitizeFilename, auth, (req, res) => {
  res.set("Content-Type", "text/plain");
  if (!req.body.timestampOldStart || !req.body.timestampDuration)
    return res.status(400).end("timestamp required");
  gfs_prim.then(gfs => {
    const fname = req.body.filename + ".webm";
    let result = gfs.createWriteStream({
      filename: fname,
      mode: "w",
      content_type: "video/webm",
      metadata: {
        uploader_id: "test",
        originalname: fname
      }
    });
    let itemOne = retrievePromise(req.params.id, gfs);
    itemOne.then(item => {
      ffmpeg(item)
        .setStartTime(req.body.timestampOldStart) //Can be in "HH:MM:SS" format also
        .setDuration(req.body.timestampDuration)
        .addOutputOption(["-b:v 0", "-crf 30", "-f webm"])
        .outputOption(["-metadata", `duration=${req.body.timestampDuration - req.body.timestampOldStart}`])
        .on("progress", progress => {
          console.log(`[Cut1]: ${JSON.stringify(progress)}`);
        })
        .on("stderr", function (stderrLine) {
          console.log("Stderr output [Cut1]: " + stderrLine);
        })
        .on("error", function (err) {
          return res
            .status(500)
            .json("An error occurred [Cut1]: " + err.message);
        })
        .on("end", function () {
          generateThumbnail(result.id, fname)
          .then(() => {
            return res.status(200).json("Cut is completed");
          })
          .catch((err) => {
            return res.status(202).json("Cut is completed: ", err)
          });
        })
        .writeToStream(result);
    });
  });
});

// @route  POST /api/edit/trim/:id/
// @desc   Remove video section at timestampStart & timestampEnd from body
// @access Private
router.post("/trim/:id/", auth, sanitizeFilename, (req, res) => {
  let timestampStart = req.body.timestampStart;
  let timestampEnd = req.body.timestampEnd;
  console.log("start: ", timestampStart);
  console.log("end: ", timestampEnd);
  if (!timestampStart || !timestampEnd)
    return res.status(400).end("timestamp required");
  if (timestampStart === "0" || timestampStart === "00:00:00.000")
    //starting at 0 not allowed by library
    timestampStart = "00:00:00.001";
  gfs_prim.then(function (gfs) {
    let itemOne = retrievePromise(req.params.id, gfs);
    let itemOneCopy = retrievePromise(req.params.id, gfs);
    let itemCopy_One = retrievePromise(req.params.id, gfs);
    const fname = req.body.filename + ".webm";
    let result = gfs.createWriteStream({
      filename: fname,
      mode: "w",
      content_type: "video/webm",
      metadata: {
        uploader_id: req.body.uploader_id,
        originalname: fname
      }
    });
    Promise.all([itemOne, itemOneCopy, itemCopy_One]).then(resultItem => {
      let itemOneStream = resultItem[0];
      let itemCopyStream = resultItem[1];
      let itemCopyOneStream = resultItem[2];
      let path1 = path.join(__dirname, "../../video_input/test");
      let path1_base = path.basename(path1).replace(path.extname(path1), ""); //filename w/o extension
      let path1_tmp = path.join(
        path.dirname(path1),
        "tmp",
        path1_base + "_1" + ".webm"
      ); //temp file loc
      let path2_tmp = path.join(
        path.dirname(path1),
        "tmp",
        path1_base + "_2" + ".webm"
      );
      let pathOut_path = path.join(
        __dirname,
        "../../video_output/",
        path.basename(path1)
      );
      let pathOut_tmp = path.join(__dirname, "../../video_output/tmp");

      ffmpeg.ffprobe(itemOneStream, function (err, metadata) {
        let duration = metadata ? metadata.format.duration : 5; //vid duration in timebase unit
        console.log("duration: ", duration);
        ffmpeg(itemCopyStream)
          .format("webm")
          .withVideoCodec("libvpx")
          .addOptions(["-b:v 0", "-crf 30"])
          .withVideoBitrate(1024)
          .withAudioCodec("libvorbis")
          .setDuration(timestampStart)
          .on("progress", progress => {
            console.log(`[Trim1]: ${JSON.stringify(progress)}`);
          })
          .on("stderr", function (stderrLine) {
            console.log("Stderr output [Trim1]: " + stderrLine);
          })
          .on("error", function (err) {
            res.json("An error occurred [Trim1]: " + err.message);
          })
          .on("end", function () {
            ffmpeg(itemCopyOneStream)
              .format("webm")
              .withVideoCodec("libvpx")
              .addOptions(["-b:v 0", "-crf 30"])
              .withVideoBitrate(1024)
              .withAudioCodec("libvorbis")
              .setStartTime(timestampEnd)
              .setDuration(duration)
              .on("progress", progress => {
                console.log(`[Trim2]: ${JSON.stringify(progress)}`);
              })
              .on("stderr", function (stderrLine) {
                console.log("Stderr output [Trim2]: " + stderrLine);
              })
              .on("error", function (err) {
                fs.unlink(path1_tmp, err => {
                  if (err)
                    console.log("Could not remove Trim2 tmp file:" + err);
                });
                res.json("An error occurred [Trim2]: " + err.message);
              })
              .on("end", function () {
                ffmpeg({ source: path1_tmp })
                  .addOutputOption(["-b:v 0", "-crf 30", "-f webm"])
                  .outputOption(["-metadata", `duration=${duration - (timestampEnd - timestampStart)}`])
                  .mergeAdd(path2_tmp)
                  .on("progress", progress => {
                    console.log(`[MergeCombine]: ${JSON.stringify(progress)}`);
                  })
                  .on("error", function (err) {
                    fs.unlink(path1_tmp, err => {
                      if (err)
                        console.log("Could not remove Trim1 tmp file:" + err);
                    });
                    fs.unlink(path2_tmp, err => {
                      if (err)
                        console.log("Could not remove Trim2 tmp file:" + err);
                    });
                    res.json("An error occurred [TrimCombine]: " + err.message);
                  })
                  .on("stderr", function (stderrLine) {
                    console.log("Stderr output [MergeCombine]:: " + stderrLine);
                  })
                  .on("end", function () {
                    fs.unlink(path1_tmp, err => {
                      if (err)
                        console.log("Could not remove Trim1 tmp file:" + err);
                    });
                    fs.unlink(path2_tmp, err => {
                      if (err)
                        console.log("Could not remove Trim2 tmp file:" + err);
                    });
                    generateThumbnail(result.id, fname)
                    .then(() => {
                      return res.status(200).json("Trimming is completed");
                    })
                    .catch((err) => {
                      return res.status(202).json("Trimming is completed: ", err)
                    });
                  })
                  .mergeToFile(result, pathOut_tmp);
              })
              .saveToFile(path2_tmp);
          })
          .saveToFile(path1_tmp);
      });
    });
  });

  /*ffmpeg({ source: path1 })
      .complexFilter([
        `[0:v]trim=start=00:00:00.000:end=00:00:02.000[av]`,
        `[0:a]atrim=start=00:00:00.000:end=00:00:02.000[aa]`,
        `[0:v]trim=start=00:00:05.000:end=00:00:21.000,setpts=PTS-STARTPTS[bv]`, //,setpts=PTS-STARTPTS[bv]
        `[0:a]atrim=start=00:00:05.000:end=00:00:21.000,asetpts=PTS-STARTPTS[ba]`, //,asetpts=PTS-STARTPTS[ba]
        `[av][aa][bv][ba]concat=:v=0:a=0[outv][outa]`
      ])
      .outputOptions([
        `-map [outv]`,
        `-map [outa]`
      ])
      .on('stderr', function(stderrLine) {
        console.log('Stderr output [MergeTrim]: ' + stderrLine);
      })
      .on('end', function() {
        res.json('Trim finished !');
      })
      .save(pathOut_path);*/
});

// @route  POST /api/edit/transition/:id/
// @desc   Add transition effects in a video at a timestamp
// @access Private
router.post("/transition/:id", auth, sanitizeFilename,  (req, res) => {
  res.set("Content-Type", "text/plain");
  if (!req.body.transitionType) {
    return res.status(400).end("transition type required");
  }
  gfs_prim.then(function (gfs) {
    let item = retrievePromise(req.params.id, gfs);
    let itemCopy = retrievePromise(req.params.id, gfs);
    const fname = req.body.filename + ".webm";
    let result = gfs.createWriteStream({
      filename: fname,
      mode: "w",
      content_type: "video/webm",
      metadata: {
        uploader_id: req.body.uploader_id,
        originalname: fname
      }
    });
    
    Promise.all([item, itemCopy]).then(function(itm) {
      let currStream = itm[0];
      let currStreamCopy = itm[1];
      ffmpeg.ffprobe(currStream, function(err, metadata) {
        let duration = metadata ? metadata.format.duration : 5;
        ffmpeg(currStreamCopy)
          .format("webm")
          .withVideoCodec("libvpx")
          .addOptions(["-b:v 0", "-crf 30"])
          .outputOption(["-metadata", `duration=${duration}`])
          .withVideoBitrate(1024)
          .withAudioCodec("libvorbis")
          .videoFilters(`${req.body.transitionType}:st=${req.body.transitionStartFrame}:d=${req.body.transitionEndFrame}`)
          .on("progress", progress => {
            console.log(`[Transition1]: ${JSON.stringify(progress)}`);
          })
          .on("stderr", function (stderrLine) {
            console.log("Stderr output [Transition1]: " + stderrLine);
          })
          .on("error", function (err) {
            return res.json("An error occurred [Transition1]: ", err.message);
          })
          .on("end", function () {
            generateThumbnail(result.id, fname)
            .then(() => {
              return res.status(200).json("Trimming is completed");
            })
            .catch((err) => {
              return res.status(202).json("Trimming is completed: ", err)
            });
          })
          .saveToFile(result);
      });
    });
  });
});

// @route POST /api/edit/saveMP3
// @desc  Save the user recording into the database once the Stop button is pressed
router.post("/saveMP3", upload.single("mp3file"), auth, sanitizeFilename, async (req, res) => {
  let metadata = {
    uploader_id: "test",//req.body.uploader_id,
    originalname: req.file.originalname
  };
  gfs_prim.then(function (gfs) {
    gfs.files.update({ _id: mongoose.Types.ObjectId(req.file.id) }, { '$set': { 'metadata': metadata } })
  });
  return res.json("mp3 file saved")
});

module.exports = {
  router: router,
  generateThumbnail: generateThumbnail
};
