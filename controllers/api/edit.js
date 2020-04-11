const express = require("express");
const router = express.Router();
const auth = require("../../middleware/auth");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("../../controllers/ff_path");
// Item model
const Item = require("../../models/Item");
const mongoose = require("mongoose");
// import stream from 'stream';
const { gfs_prim } = require("../../middleware/gridSet");
// const storage = multer.diskStorage({
//   destination: path.join(__dirname, "../../video_input/"),
//   filename: function (req, file, callback) {
//     callback(null, "recording.mp3")
//   }
// });
const upload = multer({ dest: path.join(__dirname, "../../recordings/") });
const crypto = require("crypto");

function retrievePromise(id, gfs) {
  return new Promise(function (resolve, reject) {
    gfs.files.findOne({ _id: mongoose.Types.ObjectId(id) }, (err, file) => {
      // Check if file
      if (!file || file.length === 0) {
        return reject("fail fetch", id);
      }
      const readstream = gfs.createReadStream(file.filename);
      return resolve(readstream);
    });
  });
}

function generateThumbnail(id, filename) {
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
            return ("An error occurred [Thumbnail]: ", err.message);
          })
          .on("end", function () {
            return ("Thumbnail is completed");
          })
          .saveToFile(result);
      });
    }, 500);

  });
}

// @route  POST /api/caption
// @desc   Create caption for the selected video
// @access Private
router.post("/caption/:id", (req, res) => {
  res.set("Content-Type", "text/plain");
  // check if request has valid data
  if (!req.body.data) {
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
  const fname = req.filename.toString("hex") + ".webm";
  // sub_path
  let sub_path = path
    .join(__dirname, "/../../temp/subtitle/", "t_sub.srt")
    .replace(/\\/g, "\\\\\\\\")
    .replace(":", "\\\\:");
  // Note: we need to change this, it doesn't allow 
  let srt_path = __dirname + "/../../temp/subtitle/" + req.filename + "t_sub.srt";
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
          uploader_id: "test",
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
          console.log(width);
          console.log(height);
          console.log(fps);
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
              generateThumbnail(resultFile.id, fname);
              return res.status(200).end("Caption is added");
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
router.post("/merge", upload.none(), (req, res) => {
  res.set("Content-Type", "text/plain");
  console.log(req.body.curr_vid_id)
  console.log(req.body.merge_vid_id)
  if (!req.body.curr_vid_id || !req.body.merge_vid_id)
    return res.status(400).end("video id for merging required");


  gfs_prim.then(function (gfs) {
    const curr_vid_id = req.body.curr_vid_id;
    const merge_vid_id = req.body.merge_vid_id;
    let itemOne = retrievePromise(curr_vid_id, gfs);
    let itemOneCopy = retrievePromise(curr_vid_id, gfs);
    let itemTwo = retrievePromise(merge_vid_id, gfs);
    let itemTwoCopy = retrievePromise(merge_vid_id, gfs);
    const fname = crypto.randomBytes(16).toString("hex") + ".webm";
    let result = gfs.createWriteStream({
      filename: fname,
      mode: "w",
      content_type: "video/webm",
      metadata: {
        uploader_id: "test",
        originalname: fname
      }
    });
    Promise.all([itemOne, itemOneCopy, itemTwo, itemTwoCopy]).then(function(itm) {
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
          .on('stderr', function(stderrLine) {
                        console.log('Stderr output [Merge1]: ' + stderrLine);
                      })
          .on("end", function() {
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
              .on('stderr', function(stderrLine) {
                              console.log('Stderr output [Merge2]:: ' + stderrLine);
                            })
              .on("end", function() {
                  ffmpeg({ source: path1_tmp })
                    .mergeAdd(path2_tmp)
                    .addOutputOption(["-b:v 0",  "-crf 30", "-f webm"])
                    .outputOption(["-metadata", `duration=${duration_one + duration_two}`])
                    .on("progress", progress => {
                      console.log(`[MergeCombine]: ${JSON.stringify(progress)}`);
                    })
                    .on("error", function(err) {
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
                    .on("end", function() {
                      fs.unlink(path1_tmp, err => {
                        if (err)
                          console.log("Could not remove Merge1 tmp file:" + err);
                      });
                      fs.unlink(path2_tmp, err => {
                        if (err)
                          console.log("Could not remove Merge2 tmp file:" + err);
                      });
                      generateThumbnail(result.id, fname);
                      return res.status(200).json("Merging is completed");
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
router.post("/cut/:id", (req, res) => {
  res.set("Content-Type", "text/plain");
  if (!req.body.timestampOldStart || !req.body.timestampDuration)
    return res.status(400).end("timestamp required");
  gfs_prim.then(gfs => {
    const fname = crypto.randomBytes(16).toString("hex") + ".webm";
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
          generateThumbnail(result.id, fname);
          return res.status(200).json("Operation Complete");
        })
        .writeToStream(result);
    });
  });
});

// @route  POST /api/edit/trim/:id/
// @desc   Remove video section at timestampStart & timestampEnd from body
// @access Private
router.post("/trim/:id/", upload.none(), (req, res) => {
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
    const fname = crypto.randomBytes(16).toString("hex") + ".webm";
    let result = gfs.createWriteStream({
      filename: fname,
      mode: "w",
      content_type: "video/webm",
      metadata: {
        uploader_id: "test",
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

      ffmpeg.ffprobe(itemOneStream, function(err, metadata) {
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
                  .addOutputOption(["-b:v 0",  "-crf 30", "-f webm"])
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
                    generateThumbnail(result.id, fname);
                    return res.status(200).end("Trimming is completed");
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
router.post("/transition/:id", upload.none(), (req, res) => {
  // console.log(req.body.transition_paddingVidWidth);
  // console.log(req.body.transition_paddingVidHeight);
  // console.log(req.body.transition_paddingColor);
  // console.log(req.body.transition_paddingVidRow);
  // console.log(req.body.transition_paddingVidCol);
  console.log(req.body.transitionType);
  console.log(req.body.transitionStartFrame, req.body.transitionEndFrame);
  let transitionType;
  res.set("Content-Type", "text/plain");
  if (!req.body.transitionType) {
    return res.status(400).end("transition type required");
  } else if (req.body.transitionType === "pad") {
    transitionType = `${req.body.transitionType}=width=${req.body.transition_paddingVidWidth}:height=${req.body.transition_paddingVidHeight}:x=${req.body.transition_paddingVidCol}:y=${req.body.transition_paddingVidRow}:color=${req.body.transition_paddingColor}`;
  } else if (req.body.transitionType.includes("fade")) {
    transitionType = `${req.body.transitionType}:st=${req.body.transitionStartFrame}:d=${req.body.transitionEndFrame}`;
  }
  console.log(transitionType);
  gfs_prim.then(function (gfs) {
    const fname = crypto.randomBytes(16).toString("hex") + ".webm";
    let result = gfs.createWriteStream({
      filename: fname,
      mode: "w",
      content_type: "video/webm",
      metadata: {
        uploader_id: "test",
        originalname: fname
      }
    });
    retrievePromise(req.params.id, gfs).then(function (itm) {
      ffmpeg(itm)
        .format("webm")
        .withVideoCodec("libvpx")
        .addOptions(["-b:v 0", "-crf 30"])
        .withVideoBitrate(1024)
        .withAudioCodec("libvorbis")
        .videoFilters(transitionType)
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
          generateThumbnail(result.id, fname);
        })
        .saveToFile(result);
    });
  });
});

// @route POST /api/edit/saveMP3
// @desc  Save the user recording into the database once the Stop button is pressed
router.post("/saveMP3", upload.single("mp3file"), async (req, res) => {
  // console.log("edit.js saveMP3");
  // console.log("file in backend: ", req.file)
  let gfs = await gfs_prim;

  gfs.files.findOne(
    { _id: mongoose.Types.ObjectId(req.file.id) },
    (err, file) => {
      // Check if file
      if (!file || file.length === 0) {
        return res.status(404).json({
          err: "No file exists"
        });
      }
    }
  );

  const newItem = new Item({
    uploader_id: mongoose.Types.ObjectId(req.body.uploader_id),
    gfs_id: mongoose.Types.ObjectId(req.file.id),
    originalname: req.file.originalname,
    file_path: req.file.path,
    width: 0,
    height: 0
  });

  // Write it to a file in the recordings directory
  const writeStream = gfs.createWriteStream({
    filename: req.file.filename + ".mp3",
    contentType: req.file.mimetype
  });
  fs.createReadStream(req.file.path).pipe(writeStream)

  await newItem.save();

  const { id, uploadDate, filename, md5, contentType, originalname } = req.file;
  return res.json({
    _id: id,
    uploadDate: uploadDate,
    filename: filename,
    md5: md5,
    contentType: contentType,
    uploader_id: mongoose.Types.ObjectId(req.body.uploader_id),
    originalname: originalname,
    width: newItem.width,
    height: newItem.height
  });
});

module.exports = {
  router: router,
  generateThumbnail: generateThumbnail
};
