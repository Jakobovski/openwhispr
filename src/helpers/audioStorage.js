const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const {
  isAudioFile,
  selectOverflowFiles,
  transcriptionIdFromFilename,
} = require("../utils/audioRetention");

// Stored dictations are capped rather than pruned only by age: dictation now writes 16 kHz
// PCM, roughly ten times the bytes of the Opus it used to store, so a folder that was
// self-limiting is not any more.
const AUDIO_STORAGE_CAP_BYTES = 1024 * 1024 * 1024;

class AudioStorageManager {
  constructor() {
    this.audioDir = path.join(app.getPath("userData"), "audio");
    this.ensureAudioDir();
  }

  ensureAudioDir() {
    try {
      fs.mkdirSync(this.audioDir, { recursive: true });
    } catch (error) {
      debugLogger.error(
        "Failed to create audio directory",
        { error: error.message },
        "audio-storage"
      );
    }
  }

  /**
   * Extension for the bytes actually being written.
   *
   * Dictation captures PCM now, and naming a WAV ".webm" is not cosmetic: retry uploads
   * the stored file to a provider, and OpenAI rejects a payload whose extension disagrees
   * with its contents.
   */
  _extensionFor(mimeType) {
    const type = String(mimeType || "").toLowerCase();
    if (type.includes("wav")) return ".wav";
    if (type.includes("ogg")) return ".ogg";
    if (type.includes("mp4") || type.includes("m4a")) return ".m4a";
    if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
    if (type.includes("flac")) return ".flac";
    return ".webm";
  }

  _buildFilename(transcriptionId, timestamp, extension = ".webm") {
    if (timestamp) {
      const d = new Date(timestamp);
      if (!isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, "0");
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
        return `OpenWhispr-${date}-${time}-${transcriptionId}${extension}`;
      }
    }
    return `OpenWhispr-${transcriptionId}${extension}`;
  }

  saveAudio(transcriptionId, audioBuffer, timestamp, mimeType) {
    try {
      const filename = this._buildFilename(
        transcriptionId,
        timestamp,
        this._extensionFor(mimeType)
      );
      const filePath = path.join(this.audioDir, filename);
      fs.writeFileSync(filePath, audioBuffer);
      debugLogger.debug(
        "Audio saved",
        { transcriptionId, filename, size: audioBuffer.length },
        "audio-storage"
      );
      return { success: true, path: filePath };
    } catch (error) {
      debugLogger.error(
        "Failed to save audio",
        { transcriptionId, error: error.message },
        "audio-storage"
      );
      return { success: false };
    }
  }

  getAudioPath(transcriptionId) {
    try {
      const files = fs.readdirSync(this.audioDir);
      const id = String(transcriptionId);
      const match = files.find(
        (file) => isAudioFile(file) && transcriptionIdFromFilename(file) === id
      );
      if (match) return path.join(this.audioDir, match);
    } catch {}
    return null;
  }

  getAudioBuffer(transcriptionId) {
    return this.getAudioFile(transcriptionId)?.buffer ?? null;
  }

  getAudioFile(transcriptionId) {
    const filePath = this.getAudioPath(transcriptionId);
    if (!filePath) return null;
    try {
      const extension = path.extname(filePath).toLowerCase();
      const mimeType =
        {
          ".wav": "audio/wav",
          ".ogg": "audio/ogg",
          ".m4a": "audio/mp4",
          ".mp3": "audio/mpeg",
          ".flac": "audio/flac",
          ".webm": "audio/webm",
        }[extension] || "application/octet-stream";
      return {
        buffer: fs.readFileSync(filePath),
        filePath,
        fileName: path.basename(filePath),
        mimeType,
      };
    } catch (error) {
      debugLogger.error(
        "Failed to read audio file",
        { transcriptionId, error: error.message },
        "audio-storage"
      );
      return null;
    }
  }

  deleteAudio(transcriptionId) {
    try {
      const filePath = this.getAudioPath(transcriptionId);
      if (filePath) {
        fs.unlinkSync(filePath);
        debugLogger.debug("Audio deleted", { transcriptionId }, "audio-storage");
      }
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Failed to delete audio",
        { transcriptionId, error: error.message },
        "audio-storage"
      );
      return { success: false };
    }
  }

  cleanupExpiredAudio(retentionDays, databaseManager) {
    try {
      const cutoffMs = Date.now() - retentionDays * 86400000;
      const files = fs.readdirSync(this.audioDir).filter(isAudioFile);
      const expiredIds = [];
      let kept = 0;

      for (const file of files) {
        const filePath = path.join(this.audioDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs < cutoffMs) {
            fs.unlinkSync(filePath);
            expiredIds.push(transcriptionIdFromFilename(file));
          } else {
            kept++;
          }
        } catch (error) {
          debugLogger.error(
            "Failed to process audio file during cleanup",
            { file, error: error.message },
            "audio-storage"
          );
        }
      }

      if (expiredIds.length > 0 && databaseManager) {
        databaseManager.clearAudioFlags(expiredIds);
      }

      debugLogger.info(
        "Audio cleanup complete",
        { deleted: expiredIds.length, kept, retentionDays },
        "audio-storage"
      );
      return { deleted: expiredIds.length, kept };
    } catch (error) {
      debugLogger.error("Audio cleanup failed", { error: error.message }, "audio-storage");
      return { deleted: 0, kept: 0 };
    }
  }

  deleteAllAudio() {
    try {
      const files = fs.readdirSync(this.audioDir).filter(isAudioFile);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(this.audioDir, file));
        } catch (error) {
          debugLogger.error(
            "Failed to delete audio file",
            { file, error: error.message },
            "audio-storage"
          );
        }
      }
      debugLogger.info("All audio deleted", { count: files.length }, "audio-storage");
      return { deleted: files.length };
    } catch (error) {
      debugLogger.error("Failed to delete all audio", { error: error.message }, "audio-storage");
      return { deleted: 0 };
    }
  }

  /**
   * Deletes the oldest recordings until the folder is within its cap.
   *
   * Runs after a save rather than on a timer: the folder only grows when something is
   * written, and a sweep tied to that is one the user cannot get ahead of. Clearing the
   * database flags matters as much as the unlink — a row still claiming has_audio offers a
   * retry that would fail on a missing file.
   */
  enforceStorageCap(databaseManager, maxBytes = AUDIO_STORAGE_CAP_BYTES) {
    try {
      const entries = [];
      for (const name of fs.readdirSync(this.audioDir).filter(isAudioFile)) {
        try {
          const stats = fs.statSync(path.join(this.audioDir, name));
          entries.push({ name, size: stats.size, mtimeMs: stats.mtimeMs });
        } catch {
          // A file that vanished between listing and stat needs no eviction.
        }
      }

      const { remove, totalBytes } = selectOverflowFiles(entries, maxBytes);
      if (remove.length === 0) return { deleted: 0, totalBytes };

      const deletedIds = [];
      const sizeByName = new Map(entries.map((entry) => [entry.name, entry.size]));
      let actuallyFreedBytes = 0;
      for (const name of remove) {
        try {
          fs.unlinkSync(path.join(this.audioDir, name));
          deletedIds.push(transcriptionIdFromFilename(name));
          actuallyFreedBytes += sizeByName.get(name) || 0;
        } catch (error) {
          debugLogger.error(
            "Failed to delete audio over cap",
            { file: name, error: error.message },
            "audio-storage"
          );
        }
      }
      if (deletedIds.length > 0 && databaseManager) {
        databaseManager.clearAudioFlags(deletedIds);
      }

      debugLogger.info(
        "Audio storage cap enforced",
        {
          deleted: deletedIds.length,
          freedMb: Math.round(actuallyFreedBytes / 1048576),
          totalMb: Math.round((totalBytes - actuallyFreedBytes) / 1048576),
          capMb: Math.round(maxBytes / 1048576),
        },
        "audio-storage"
      );
      return { deleted: deletedIds.length, totalBytes: totalBytes - actuallyFreedBytes };
    } catch (error) {
      debugLogger.error("Audio cap sweep failed", { error: error.message }, "audio-storage");
      return { deleted: 0, totalBytes: 0 };
    }
  }

  getStorageUsage() {
    try {
      const files = fs.readdirSync(this.audioDir).filter(isAudioFile);
      let totalBytes = 0;
      for (const file of files) {
        try {
          const stats = fs.statSync(path.join(this.audioDir, file));
          totalBytes += stats.size;
        } catch {
          // Skip files that can't be stat'd
        }
      }
      return { fileCount: files.length, totalBytes };
    } catch (error) {
      debugLogger.error("Failed to get storage usage", { error: error.message }, "audio-storage");
      return { fileCount: 0, totalBytes: 0 };
    }
  }
}

module.exports = AudioStorageManager;
module.exports.AUDIO_STORAGE_CAP_BYTES = AUDIO_STORAGE_CAP_BYTES;
