# 🎬 Smart Skip

**Automatically skip intros, recaps, credits, ads, and navigate to next episodes on popular streaming platforms**

[![Firefox Extension](https://img.shields.io/badge/Firefox-Extension-orange?logo=firefox)](https://addons.mozilla.org/firefox/)
[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/Nick190401/VideoPlayerSkipper)
[![License](https://img.shields.io/badge/license-Custom-green)](LICENSE)

---

## ✨ Features

### 🚀 **Intelligent Auto-Skip**
- **Skip Intro** - Automatically clicks "Skip Intro" buttons
- **Skip Recap** - Skips "Previously on..." recaps
- **Skip Credits** - Bypasses end credits
- **Skip Ads** - Removes advertisement interruptions
- **Auto Next Episode** - Seamlessly continues to next episodes

### 🎯 **Smart Series Detection**
- Automatically detects the current series you're watching
- Series-specific settings for granular control
- Real-time adaptation to content changes
- Multi-language support (English, German, French, Spanish, Italian, Portuguese, Dutch, Polish, Russian, Japanese, Korean, Chinese)

### ⚙️ **Flexible Configuration**
- **Global Settings** - Apply preferences across all platforms
- **Domain-Specific Settings** - Different rules for each streaming service
- **Series-Specific Settings** - Custom behavior for individual shows
- **Language Selection** - Interface adapts to your browser language with manual override option

### 🌐 **Extensive Platform Support**
- **Netflix** (all regions) - Advanced series/episode detection
- **Disney+** - Full content navigation
- **Amazon Prime Video** - Complete skip functionality
- **YouTube** - Video skip features
- **Crunchyroll** - Anime-optimized detection
- **Apple TV+** - Seamless integration
- **HBO Max / Max** - Complete feature set
- **Hulu, Paramount+, Peacock** - Full support
- **German Platforms** - Sky, Joyn, RTL, ProSieben, ZDF, ARD, Mediathek

---

## 🚀 Installation

### Firefox (Recommended)
1. Download the latest release from [GitHub Releases](https://github.com/Nick190401/VideoPlayerSkipper/releases)
2. Open Firefox and navigate to `about:addons`
3. Click the gear icon and select "Install Add-on From File"
4. Select the downloaded `.xpi` file
5. Click "Add" to confirm installation

### Development Installation
1. Clone this repository:
   ```bash
   git clone https://github.com/Nick190401/VideoPlayerSkipper.git
   cd VideoPlayerSkipper
   ```
2. Open Firefox and navigate to `about:debugging`
3. Click "This Firefox" in the sidebar
4. Click "Load Temporary Add-on"
5. Select `manifest.json` from the project directory

---

## 🎮 Usage

### Quick Start
1. **Install the extension** using the instructions above
2. **Visit any supported streaming platform** (Netflix, Disney+, etc.)
3. **Start watching content** - Smart Skip will automatically detect your series
4. **Open the popup** by clicking the extension icon to configure settings

### Configuration Options

#### Global Settings
- **Enable/Disable** the extension globally
- **Verbose Logging** for debugging (developer option)

#### Series-Specific Settings
- **Skip Intro** - Auto-click "Skip Intro" buttons
- **Skip Recap** - Auto-click recap skip options
- **Skip Credits** - Auto-click credit skip buttons
- **Skip Ads** - Auto-click advertisement skip buttons
- **Auto Next Episode** - Automatically advance to next episodes

#### Platform Settings
- **Enable for this website** - Toggle functionality per streaming service
- Overrides global settings for specific platforms

### Language Support
The extension automatically detects your browser language and displays the interface accordingly. Supported languages include:
- 🇺🇸 English
- 🇩🇪 German (Deutsch)
- 🇫🇷 French (Français)
- 🇪🇸 Spanish (Español)
- 🇮🇹 Italian (Italiano)
- 🇵🇹 Portuguese (Português)
- 🇳🇱 Dutch (Nederlands)
- 🇵🇱 Polish (Polski)
- 🇷🇺 Russian (Русский)
- 🇯🇵 Japanese (日本語)
- 🇰🇷 Korean (한국어)
- 🇨🇳 Chinese (中文)

You can manually override the language selection in the extension popup.

---

## 🛠️ Technical Features

### Intelligent Detection System
- **Event-Driven Detection** - Responds to navigation, video events, and DOM changes
- **Adaptive Polling** - Frequent scanning when searching for content, reduced when series detected
- **Platform-Specific Logic** - Optimized detection algorithms for each streaming service
- **Robust Error Handling** - Graceful fallbacks and error recovery

### Advanced Netflix Integration
- **Page Type Recognition** - Distinguishes between watch pages, title pages, and browse pages
- **Dynamic Content Handling** - Adapts to Netflix's complex SPA architecture
- **Series vs Episode Detection** - Accurately separates series titles from episode information
- **Multi-Language Title Extraction** - Works across all Netflix regions

### Storage & Sync
- **Cross-Device Synchronization** - Settings sync across your Firefox installations
- **Local Fallback** - Reliable storage even when sync is unavailable
- **Robust Data Persistence** - Multiple storage layers for maximum reliability

---

## 🏗️ Architecture

### Project Structure
```
Smart Skip/
├── manifest.json              # Extension configuration
├── src/
│   ├── content/
│   │   └── skipper.js        # Main content script with skip logic
│   ├── popup/
│   │   ├── popup.html        # Extension popup interface
│   │   └── popup.js          # Popup logic and settings management
│   ├── background/
│   │   └── background.js     # Background script for messaging
│   └── shared/
│       └── language.js       # Multi-language support system
├── assets/
│   └── icons/
│       └── icon.svg          # Extension icon
└── README.md                 # This file
```

### Core Components

#### Content Script (`skipper.js`)
- Series detection and extraction logic
- Button scanning and clicking algorithms
- Multi-language pattern matching
- Event-driven optimization system
- Platform-specific extraction methods

#### Popup Interface (`popup.html`, `popup.js`)
- Intuitive settings management
- Real-time series detection display
- Language selection interface
- Platform-specific toggles

#### Language System (`language.js`)
- Automatic browser language detection
- Manual language override capability
- Comprehensive translation support
- Dynamic interface updates

---

## 🐛 Troubleshooting

### Common Issues

#### Extension Not Working
1. **Check if the platform is supported** - See the supported platforms list above
2. **Verify settings** - Open the popup and ensure "Enable for this website" is checked
3. **Refresh the page** - Sometimes a page refresh helps with detection
4. **Check browser compatibility** - Currently optimized for Firefox

#### Series Not Detected
1. **Wait a moment** - Detection can take a few seconds on complex pages
2. **Navigate to a video page** - Make sure you're on an actual content page, not browsing
3. **Check verbose logging** - Enable in settings to see detailed detection information

#### Settings Not Saving
1. **Check storage permissions** - Ensure the extension has storage permissions
2. **Try local storage** - The extension automatically falls back to local storage if sync fails
3. **Disable and re-enable** - Sometimes helps reset the storage system

### Debug Information
Enable "Verbose Logging" in the extension popup to see detailed information about:
- Series detection attempts
- Button scanning results
- Setting changes and storage operations
- Platform-specific logic execution

---

## 🤝 Contributing

We welcome contributions to Smart Skip! Here's how you can help:

### Development Setup
1. Fork the repository
2. Clone your fork locally
3. Load the extension in Firefox developer mode
4. Make your changes
5. Test thoroughly across multiple platforms
6. Submit a pull request

### Contribution Guidelines
- **Code Quality** - Follow the existing code style and patterns
- **Testing** - Test on multiple streaming platforms and browsers
- **Documentation** - Update README and code comments as needed
- **Compatibility** - Ensure changes work across all supported platforms

### Areas for Contribution
- **New Platform Support** - Add support for additional streaming services
- **Language Translations** - Expand multi-language support
- **Bug Fixes** - Improve reliability and edge case handling
- **Performance Optimization** - Enhance detection speed and accuracy
- **UI/UX Improvements** - Enhance the popup interface and user experience

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- **Streaming Platforms** - For providing the entertainment we love to watch
- **Firefox Community** - For excellent extension development tools and documentation
- **Open Source Contributors** - For inspiration and code patterns
- **Beta Testers** - For helping identify and fix issues across different platforms

---

## 📞 Support

- **Issues** - Report bugs and request features on [GitHub Issues](https://github.com/Nick190401/VideoPlayerSkipper/issues)
- **Discussions** - Join conversations on [GitHub Discussions](https://github.com/Nick190401/VideoPlayerSkipper/discussions)
- **Updates** - Follow the project for updates and new releases

---

<div align="center">

**Enjoy uninterrupted streaming! 🍿**

*Made with ❤️ for binge-watchers everywhere*

</div>