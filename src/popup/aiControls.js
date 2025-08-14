// AI Settings Integration for Smart Skip Popup

// Add AI controls to popup interface
function addAIControls() {
  const mainContainer = document.querySelector('.main-container');
  if (!mainContainer) return;
  
  // Create AI settings section
  const aiSection = document.createElement('div');
  aiSection.className = 'ai-section';
  aiSection.innerHTML = `
    <div class="section-header">
      <h3>🤖 AI-Powered Detection</h3>
      <p class="section-description">Machine learning for intelligent content recognition</p>
    </div>
    
    <div class="setting-item">
      <label class="switch">
        <input type="checkbox" id="ai-enabled">
        <span class="slider"></span>
      </label>
      <div class="setting-label">
        <span>Enable AI Detection</span>
        <small>Uses machine learning to predict skip-worthy content</small>
      </div>
    </div>
    
    <div class="ai-advanced" id="ai-advanced" style="display: none;">
      <div class="setting-item">
        <label for="ai-confidence">Confidence Threshold: <span id="confidence-value">75%</span></label>
        <input type="range" id="ai-confidence" min="10" max="95" value="75" class="slider-range">
        <small>Higher values = more conservative AI predictions</small>
      </div>
      
      <div class="ai-stats" id="ai-stats">
        <h4>AI Statistics</h4>
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-value" id="total-predictions">-</span>
            <span class="stat-label">Predictions Made</span>
          </div>
          <div class="stat-item">
            <span class="stat-value" id="accuracy-rate">-</span>
            <span class="stat-label">Accuracy Rate</span>
          </div>
          <div class="stat-item">
            <span class="stat-value" id="patterns-learned">-</span>
            <span class="stat-label">Patterns Learned</span>
          </div>
        </div>
      </div>
      
      <div class="ai-actions">
        <button id="test-ai" class="btn-secondary">Test AI Detection</button>
        <button id="reset-ai" class="btn-secondary">Reset Learning Data</button>
      </div>
    </div>
  `;
  
  // Insert before series settings
  const seriesSection = document.querySelector('.series-container');
  if (seriesSection) {
    mainContainer.insertBefore(aiSection, seriesSection);
  } else {
    mainContainer.appendChild(aiSection);
  }
  
  // Add CSS for AI controls
  addAIStyles();
  
  // Setup event listeners
  setupAIEventListeners();
  
  // Load current AI settings
  loadAISettings();
}

function addAIStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .ai-section {
      margin: 15px 0;
      padding: 15px;
      border: 2px solid #667eea;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(102, 126, 234, 0.1), rgba(118, 75, 162, 0.1));
      position: relative;
      overflow: hidden;
    }
    
    .ai-section::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #667eea, #764ba2);
    }
    
    .ai-section .section-header h3 {
      margin: 0 0 5px 0;
      color: #667eea;
      font-size: 16px;
      font-weight: 600;
    }
    
    .ai-section .section-description {
      margin: 0 0 15px 0;
      color: #666;
      font-size: 12px;
      font-style: italic;
    }
    
    .ai-advanced {
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid #eee;
    }
    
    .slider-range {
      width: 100%;
      height: 6px;
      border-radius: 3px;
      background: #ddd;
      outline: none;
      margin: 5px 0;
    }
    
    .slider-range::-webkit-slider-thumb {
      appearance: none;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #667eea;
      cursor: pointer;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    
    .slider-range::-moz-range-thumb {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #667eea;
      cursor: pointer;
      border: none;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    
    .ai-stats {
      margin: 15px 0;
      padding: 10px;
      background: rgba(255,255,255,0.5);
      border-radius: 6px;
    }
    
    .ai-stats h4 {
      margin: 0 0 10px 0;
      font-size: 14px;
      color: #333;
    }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }
    
    .stat-item {
      text-align: center;
      padding: 8px;
      background: white;
      border-radius: 4px;
      border: 1px solid #eee;
    }
    
    .stat-value {
      display: block;
      font-size: 18px;
      font-weight: bold;
      color: #667eea;
    }
    
    .stat-label {
      display: block;
      font-size: 10px;
      color: #666;
      margin-top: 2px;
    }
    
    .ai-actions {
      display: flex;
      gap: 10px;
      margin-top: 15px;
    }
    
    .btn-secondary {
      flex: 1;
      padding: 8px 12px;
      background: #f8f9fa;
      border: 1px solid #667eea;
      border-radius: 4px;
      color: #667eea;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
    }
    
    .btn-secondary:hover {
      background: #667eea;
      color: white;
    }
    
    .ai-section.disabled {
      opacity: 0.6;
      pointer-events: none;
    }
  `;
  
  document.head.appendChild(style);
}

function setupAIEventListeners() {
  const aiEnabled = document.getElementById('ai-enabled');
  const aiAdvanced = document.getElementById('ai-advanced');
  const confidenceSlider = document.getElementById('ai-confidence');
  const confidenceValue = document.getElementById('confidence-value');
  const testAIButton = document.getElementById('test-ai');
  const resetAIButton = document.getElementById('reset-ai');
  
  // Toggle AI detection
  aiEnabled.addEventListener('change', function() {
    const isEnabled = this.checked;
    aiAdvanced.style.display = isEnabled ? 'block' : 'none';
    
    // Send to content script
    sendToActiveTab({
      action: 'updateAI',
      enabled: isEnabled
    });
    
    // Save setting
    saveAISetting('aiDetection', isEnabled);
    
    if (isEnabled) {
      updateAIStats();
    }
  });
  
  // Confidence threshold
  confidenceSlider.addEventListener('input', function() {
    const value = this.value;
    confidenceValue.textContent = value + '%';
    
    // Send to content script
    sendToActiveTab({
      action: 'updateAIConfidence',
      confidence: value / 100
    });
    
    // Save setting
    saveAISetting('aiConfidence', value / 100);
  });
  
  // Test AI detection
  testAIButton.addEventListener('click', function() {
    this.disabled = true;
    this.textContent = 'Testing...';
    
    sendToActiveTab({
      action: 'testAI'
    });
    
    setTimeout(() => {
      this.disabled = false;
      this.textContent = 'Test AI Detection';
      updateAIStats();
    }, 2000);
  });
  
  // Reset learning data
  resetAIButton.addEventListener('click', function() {
    if (confirm('Reset all AI learning data? This cannot be undone.')) {
      sendToActiveTab({
        action: 'resetAI'
      });
      
      // Clear local storage
      chrome.storage.local.remove(['aiTrainingData']);
      
      updateAIStats();
    }
  });
}

async function loadAISettings() {
  try {
    // Load from storage
    const settings = await chrome.storage.sync.get(['skipperSettings']);
    const skipperSettings = settings.skipperSettings || {};
    
    const aiEnabled = document.getElementById('ai-enabled');
    const confidenceSlider = document.getElementById('ai-confidence');
    const confidenceValue = document.getElementById('confidence-value');
    const aiAdvanced = document.getElementById('ai-advanced');
    
    // Set AI enabled state
    const isEnabled = skipperSettings.aiDetection || false;
    aiEnabled.checked = isEnabled;
    aiAdvanced.style.display = isEnabled ? 'block' : 'none';
    
    // Set confidence threshold
    const confidence = (skipperSettings.aiConfidence || 0.75) * 100;
    confidenceSlider.value = confidence;
    confidenceValue.textContent = Math.round(confidence) + '%';
    
    // Update stats if enabled
    if (isEnabled) {
      updateAIStats();
    }
    
  } catch (error) {
    console.error('Error loading AI settings:', error);
  }
}

async function updateAIStats() {
  try {
    // Get stats from content script
    const stats = await sendToActiveTabPromise({
      action: 'getAIStats'
    });
    
    if (stats) {
      document.getElementById('total-predictions').textContent = stats.totalPredictions || '0';
      document.getElementById('accuracy-rate').textContent = (stats.accuracyRate || 0) + '%';
      
      const patternsLearned = stats.patternsLearned || {};
      const totalPatterns = Object.values(patternsLearned).reduce((sum, count) => sum + count, 0);
      document.getElementById('patterns-learned').textContent = totalPatterns;
    }
  } catch (error) {
    console.warn('Could not get AI stats:', error);
    // Set fallback values
    document.getElementById('total-predictions').textContent = '-';
    document.getElementById('accuracy-rate').textContent = '-';
    document.getElementById('patterns-learned').textContent = '-';
  }
}

async function saveAISetting(key, value) {
  try {
    const settings = await chrome.storage.sync.get(['skipperSettings']);
    const skipperSettings = settings.skipperSettings || {};
    
    skipperSettings[key] = value;
    
    await chrome.storage.sync.set({ skipperSettings });
  } catch (error) {
    console.error('Error saving AI setting:', error);
  }
}

function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, message);
    }
  });
}

function sendToActiveTabPromise(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message, function(response) {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(response);
          }
        });
      } else {
        reject(new Error('No active tab found'));
      }
    });
  });
}

// Initialize AI controls when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', addAIControls);
} else {
  addAIControls();
}
