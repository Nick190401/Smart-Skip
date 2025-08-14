-- Smart Skip AI Content Detection Database Structure
-- Created: 2025-08-15
-- Database for sharing AI learning data between users

-- Create Database (optional - can be created manually in phpMyAdmin)
-- CREATE DATABASE smart_skip_ai DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- USE smart_skip_ai;

-- =====================================================
-- 1. VIDEO FINGERPRINTS TABLE
-- Stores unique video identifiers and metadata
-- =====================================================
CREATE TABLE `video_fingerprints` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `video_hash` varchar(64) NOT NULL COMMENT 'SHA256 hash of video characteristics',
  `platform` enum('youtube','netflix','disney','amazon','hulu','other') NOT NULL DEFAULT 'other',
  `video_title` varchar(255) DEFAULT NULL COMMENT 'Optional video title (anonymized)',
  `duration_seconds` int(11) DEFAULT NULL,
  `video_metadata` json DEFAULT NULL COMMENT 'Additional video info (resolution, fps, etc.)',
  `first_seen` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `total_users` int(11) DEFAULT 1 COMMENT 'Number of users who watched this video',
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_video_hash` (`video_hash`),
  KEY `idx_platform` (`platform`),
  KEY `idx_duration` (`duration_seconds`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- 2. CONTENT PREDICTIONS TABLE
-- Stores AI predictions with features and confidence
-- =====================================================
CREATE TABLE `content_predictions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `video_fingerprint_id` int(11) NOT NULL,
  `timestamp_seconds` int(11) NOT NULL COMMENT 'Time position in video',
  `content_type` enum('intro','recap','credits','ad','unknown') NOT NULL,
  `confidence_score` decimal(4,3) NOT NULL COMMENT 'Confidence 0.000-1.000',
  `prediction_quality` enum('excellent','good','learning','uncertain','very_low') NOT NULL,
  `audio_features` json DEFAULT NULL COMMENT 'Audio fingerprint and features',
  `visual_features` json DEFAULT NULL COMMENT 'Visual analysis results',
  `context_features` json DEFAULT NULL COMMENT 'Timing and context data',
  `reasoning` json DEFAULT NULL COMMENT 'AI reasoning for prediction',
  `suggested_action` enum('skip','watch','none') NOT NULL DEFAULT 'none',
  `user_session_id` varchar(64) NOT NULL COMMENT 'Anonymous user session',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_video_fingerprint` (`video_fingerprint_id`),
  KEY `idx_timestamp` (`timestamp_seconds`),
  KEY `idx_content_type` (`content_type`),
  KEY `idx_confidence` (`confidence_score`),
  KEY `idx_created` (`created_at`),
  CONSTRAINT `fk_predictions_video` FOREIGN KEY (`video_fingerprint_id`) REFERENCES `video_fingerprints` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- 3. USER ACTIONS TABLE
-- Records user skip/watch actions for learning
-- =====================================================
CREATE TABLE `user_actions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `video_fingerprint_id` int(11) NOT NULL,
  `timestamp_seconds` int(11) NOT NULL,
  `action_type` enum('manual_skip','auto_skip','watch','pause','seek') NOT NULL,
  `action_value` int(11) DEFAULT NULL COMMENT 'Skip duration or seek position',
  `prediction_id` int(11) DEFAULT NULL COMMENT 'Related prediction if any',
  `user_session_id` varchar(64) NOT NULL,
  `client_timestamp` timestamp NOT NULL COMMENT 'When action happened on client',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_action_video` (`video_fingerprint_id`),
  KEY `fk_action_prediction` (`prediction_id`),
  KEY `idx_action_type` (`action_type`),
  KEY `idx_timestamp` (`timestamp_seconds`),
  KEY `idx_user_session` (`user_session_id`),
  CONSTRAINT `fk_actions_video` FOREIGN KEY (`video_fingerprint_id`) REFERENCES `video_fingerprints` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_actions_prediction` FOREIGN KEY (`prediction_id`) REFERENCES `content_predictions` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- 4. AUDIO FINGERPRINTS TABLE
-- Stores unique audio patterns for recognition
-- =====================================================
CREATE TABLE `audio_fingerprints` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `fingerprint_hash` varchar(64) NOT NULL COMMENT 'Hash of audio fingerprint',
  `fingerprint_data` text NOT NULL COMMENT 'Compressed audio fingerprint',
  `content_type` enum('intro','recap','credits','ad','music','voice') NOT NULL,
  `confidence_level` decimal(4,3) NOT NULL,
  `energy_level` decimal(6,2) DEFAULT NULL,
  `tempo_bpm` int(11) DEFAULT NULL,
  `spectral_centroid` decimal(8,2) DEFAULT NULL,
  `match_count` int(11) DEFAULT 1 COMMENT 'How many times this pattern was matched',
  `accuracy_rate` decimal(4,3) DEFAULT NULL COMMENT 'Success rate of predictions',
  `first_detected` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_matched` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_fingerprint` (`fingerprint_hash`),
  KEY `idx_content_type` (`content_type`),
  KEY `idx_confidence` (`confidence_level`),
  KEY `idx_match_count` (`match_count`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- 5. VISUAL PATTERNS TABLE
-- Stores visual recognition patterns
-- =====================================================
CREATE TABLE `visual_patterns` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `pattern_hash` varchar(64) NOT NULL,
  `pattern_type` enum('text','logo','color_scheme','scene_change','brightness_pattern') NOT NULL,
  `content_type` enum('intro','recap','credits','ad') NOT NULL,
  `brightness_avg` decimal(5,2) DEFAULT NULL,
  `contrast_level` decimal(6,2) DEFAULT NULL,
  `dominant_colors` json DEFAULT NULL COMMENT 'Top 5 dominant colors',
  `text_probability` decimal(4,3) DEFAULT NULL,
  `edge_density` decimal(6,4) DEFAULT NULL,
  `confidence_level` decimal(4,3) NOT NULL,
  `match_count` int(11) DEFAULT 1,
  `accuracy_rate` decimal(4,3) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_pattern` (`pattern_hash`),
  KEY `idx_pattern_type` (`pattern_type`),
  KEY `idx_content_type` (`content_type`),
  KEY `idx_confidence` (`confidence_level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- 6. LEARNING STATISTICS TABLE
-- Aggregated statistics for AI performance
-- =====================================================
CREATE TABLE `learning_statistics` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `video_fingerprint_id` int(11) NOT NULL,
  `content_type` enum('intro','recap','credits','ad') NOT NULL,
  `total_predictions` int(11) DEFAULT 0,
  `correct_predictions` int(11) DEFAULT 0,
  `accuracy_rate` decimal(4,3) GENERATED ALWAYS AS (CASE WHEN `total_predictions` > 0 THEN `correct_predictions` / `total_predictions` ELSE 0 END) STORED,
  `avg_confidence` decimal(4,3) DEFAULT NULL,
  `skip_rate` decimal(4,3) DEFAULT NULL COMMENT 'How often users skip this content type',
  `total_users` int(11) DEFAULT 0,
  `last_updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_video_content` (`video_fingerprint_id`,`content_type`),
  KEY `idx_accuracy` (`accuracy_rate`),
  KEY `idx_content_type` (`content_type`),
  CONSTRAINT `fk_stats_video` FOREIGN KEY (`video_fingerprint_id`) REFERENCES `video_fingerprints` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- 7. GLOBAL AI SETTINGS TABLE
-- Stores global AI configuration and thresholds
-- =====================================================
CREATE TABLE `ai_settings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `setting_key` varchar(100) NOT NULL,
  `setting_value` json NOT NULL,
  `description` text DEFAULT NULL,
  `last_updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_setting` (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- 8. USER SESSIONS TABLE (Optional - for analytics)
-- Anonymous user session tracking
-- =====================================================
CREATE TABLE `user_sessions` (
  `session_id` varchar(64) NOT NULL,
  `extension_version` varchar(20) DEFAULT NULL,
  `browser_info` json DEFAULT NULL,
  `ai_enabled` tinyint(1) DEFAULT 1,
  `confidence_threshold` decimal(4,3) DEFAULT 0.800,
  `total_predictions` int(11) DEFAULT 0,
  `total_skips` int(11) DEFAULT 0,
  `session_start` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_activity` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`session_id`),
  KEY `idx_last_activity` (`last_activity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- INITIAL DATA AND SETTINGS
-- =====================================================

-- Insert default AI settings
INSERT INTO `ai_settings` (`setting_key`, `setting_value`, `description`) VALUES
('default_confidence_threshold', '0.800', 'Default confidence threshold for new users'),
('auto_adjustment_enabled', 'true', 'Whether auto-threshold adjustment is enabled'),
('min_confidence_threshold', '0.500', 'Minimum allowed confidence threshold'),
('max_confidence_threshold', '0.950', 'Maximum allowed confidence threshold'),
('learning_rate', '0.010', 'Neural network learning rate'),
('max_learning_data_size', '1000000', 'Maximum number of learning entries per user'),
('data_retention_days', '90', 'How long to keep old prediction data'),
('api_version', '\"2.0.0\"', 'Current API version');

-- =====================================================
-- USEFUL VIEWS FOR ANALYTICS
-- =====================================================

-- View: Content Type Performance
CREATE VIEW `content_performance` AS
SELECT 
  vf.platform,
  cp.content_type,
  COUNT(*) as total_predictions,
  AVG(cp.confidence_score) as avg_confidence,
  COUNT(CASE WHEN ua.action_type = 'manual_skip' THEN 1 END) as manual_skips,
  COUNT(CASE WHEN ua.action_type = 'auto_skip' THEN 1 END) as auto_skips,
  (COUNT(CASE WHEN ua.action_type IN ('manual_skip', 'auto_skip') THEN 1 END) / COUNT(*)) as skip_rate
FROM content_predictions cp
JOIN video_fingerprints vf ON cp.video_fingerprint_id = vf.id
LEFT JOIN user_actions ua ON cp.id = ua.prediction_id
GROUP BY vf.platform, cp.content_type;

-- View: Daily AI Statistics
CREATE VIEW `daily_ai_stats` AS
SELECT 
  DATE(cp.created_at) as prediction_date,
  cp.content_type,
  COUNT(*) as predictions_count,
  AVG(cp.confidence_score) as avg_confidence,
  COUNT(DISTINCT cp.user_session_id) as unique_users,
  COUNT(CASE WHEN cp.confidence_score >= 0.8 THEN 1 END) as high_confidence_predictions
FROM content_predictions cp
WHERE cp.created_at >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY)
GROUP BY DATE(cp.created_at), cp.content_type
ORDER BY prediction_date DESC;

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- Additional composite indexes for common queries
CREATE INDEX `idx_video_timestamp` ON `content_predictions` (`video_fingerprint_id`, `timestamp_seconds`);
CREATE INDEX `idx_session_content` ON `content_predictions` (`user_session_id`, `content_type`);
CREATE INDEX `idx_confidence_type` ON `content_predictions` (`confidence_score`, `content_type`);
CREATE INDEX `idx_platform_type` ON `video_fingerprints` (`platform`, `duration_seconds`);

-- =====================================================
-- TRIGGERS FOR AUTOMATIC STATISTICS UPDATES
-- =====================================================

DELIMITER $$

-- Trigger: Update learning statistics when new prediction is added
CREATE TRIGGER `update_learning_stats_on_prediction` 
AFTER INSERT ON `content_predictions`
FOR EACH ROW
BEGIN
  INSERT INTO learning_statistics (video_fingerprint_id, content_type, total_predictions, avg_confidence)
  VALUES (NEW.video_fingerprint_id, NEW.content_type, 1, NEW.confidence_score)
  ON DUPLICATE KEY UPDATE
    total_predictions = total_predictions + 1,
    avg_confidence = (avg_confidence * (total_predictions - 1) + NEW.confidence_score) / total_predictions;
END$$

-- Trigger: Update user session statistics
CREATE TRIGGER `update_session_stats`
AFTER INSERT ON `content_predictions`
FOR EACH ROW
BEGIN
  INSERT INTO user_sessions (session_id, total_predictions)
  VALUES (NEW.user_session_id, 1)
  ON DUPLICATE KEY UPDATE
    total_predictions = total_predictions + 1,
    last_activity = CURRENT_TIMESTAMP;
END$$

DELIMITER ;

-- =====================================================
-- SAMPLE QUERIES FOR TESTING
-- =====================================================

/*
-- Test query: Get most accurate content type predictions
SELECT content_type, AVG(confidence_score) as avg_confidence, COUNT(*) as total_predictions
FROM content_predictions 
WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY content_type
ORDER BY avg_confidence DESC;

-- Test query: Get top performing audio fingerprints
SELECT content_type, AVG(confidence_level) as avg_confidence, match_count
FROM audio_fingerprints
WHERE match_count > 5
ORDER BY avg_confidence DESC, match_count DESC
LIMIT 10;

-- Test query: User skip behavior analysis
SELECT 
  vf.platform,
  cp.content_type,
  COUNT(*) as total_predictions,
  COUNT(CASE WHEN ua.action_type IN ('manual_skip', 'auto_skip') THEN 1 END) as total_skips,
  (COUNT(CASE WHEN ua.action_type IN ('manual_skip', 'auto_skip') THEN 1 END) / COUNT(*) * 100) as skip_percentage
FROM content_predictions cp
JOIN video_fingerprints vf ON cp.video_fingerprint_id = vf.id
LEFT JOIN user_actions ua ON cp.video_fingerprint_id = ua.video_fingerprint_id 
  AND ABS(cp.timestamp_seconds - ua.timestamp_seconds) <= 5
GROUP BY vf.platform, cp.content_type;
*/
