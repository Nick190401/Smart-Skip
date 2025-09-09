# 🎬 Smart Skip

**Automatically skip intros, recaps, credits, ads, and navigate to next episodes on popular streaming platforms**

[![Firefox Extension](https://img.shields.io/badge/Firefox-Extension-orange?logo=firefox)](https://addons.mozilla.org/firefox/)
[![Version](https://img.shields.io/badge/version-1.1.6-blue)](https://github.com/Nick190401/VideoPlayerSkipper)
[![License](https://img.shields.io/badge/license-Custom-green)](LICENSE)
[![Manifest](https://img.shields.io/badge/manifest-v3-brightgreen)](manifest.json)

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
- **Netflix** (all regions) - Advanced series/episode detection with multi-language support
- **Disney+** - Full content navigation and seamless episode switching
- **Amazon Prime Video** (all regions) - Complete skip functionality across all Amazon domains
- **YouTube** - Video skip features and ad blocking
- **Crunchyroll** - Anime-optimized detection with episode tracking
- **Apple TV+** - Seamless integration with Apple's streaming platform
- **HBO Max / Max** - Complete feature set for HBO content
- **Hulu** - Full support for Hulu originals and licensed content
- **Paramount+** - Complete Paramount streaming integration
- **Peacock** - NBC Universal content optimization
- **Funimation** - Anime streaming with advanced detection
- **Wakanim** - European anime streaming support
- **German Platforms** - Sky, Joyn, RTL+, ProSieben, ZDF, ARD, Mediathek
- **Additional Platforms** - Twitch, Vimeo, Dailymotion support

---

## 🚀 Installation

### Firefox Add-ons Store (Recommended)
*Coming soon to the official Firefox Add-ons store*

### Manual Installation
1. Download the latest release from [GitHub Releases](https://github.com/Nick190401/VideoPlayerSkipper/releases)
2. Open Firefox and navigate to `about:addons`
3. Click the gear icon and select "Install Add-on From File"
4. Select the downloaded `.xpi` file
5. Click "Add" to confirm installation
6. Grant necessary permissions when prompted

### Development Installation
1. Clone this repository:
   ```bash
   git clone https://github.com/Nick190401/VideoPlayerSkipper.git
   cd Smart-Skip
   ```
2. Open Firefox and navigate to `about:debugging`
3. Click "This Firefox" in the sidebar
4. Click "Load Temporary Add-on"
5. Select `manifest.json` from the project directory

### Chrome/Chromium (Experimental)
While optimized for Firefox, the extension may work in Chrome:
1. Download the source code
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the project directory

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
- **Event-Driven Detection** - Responds to navigation, video events, and DOM changes in real-time
- **Adaptive Polling** - Frequent scanning when searching for content, reduced when series detected for optimal performance
- **Platform-Specific Logic** - Optimized detection algorithms tailored for each streaming service
- **Robust Error Handling** - Graceful fallbacks and comprehensive error recovery
- **Multi-Language Pattern Matching** - Supports button text detection in 12+ languages
- **Smart Cooldown System** - Prevents rapid-fire clicking and button spam

### Advanced Netflix Integration
- **Page Type Recognition** - Distinguishes between watch pages, title pages, and browse pages
- **Dynamic Content Handling** - Adapts to Netflix's complex Single Page Application architecture
- **Series vs Episode Detection** - Accurately separates series titles from episode information
- **Multi-Language Title Extraction** - Works across all Netflix regions and languages
- **Episode Progress Tracking** - Detects episode changes and series navigation
- **Seamless Playback Integration** - Works with Netflix's autoplay and continue watching features

### Cross-Platform Compatibility
- **Manifest V3** - Built with the latest extension standards for future-proofing
- **Unified Content Scripts** - Single codebase works across all supported platforms
- **Domain-Specific Optimization** - Tailored extraction methods for each streaming service
- **Universal Button Detection** - Language-independent button pattern matching
- **Responsive Design** - Popup interface adapts to different screen sizes

### Storage & Sync
- **Cross-Device Synchronization** - Settings sync across your Firefox installations using Firefox Sync
- **Local Fallback** - Reliable local storage when sync is unavailable
- **Robust Data Persistence** - Multiple storage layers (sync → local → localStorage → memory) for maximum reliability
- **Real-time Updates** - Settings changes apply immediately across all tabs
- **Data Integrity** - Automatic validation and error recovery for corrupted settings

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

#### Background Service Worker (`background.js`)
- Settings synchronization across devices
- Cross-tab communication and messaging
- Extension lifecycle management
- Storage optimization and caching

---

## 🐛 Troubleshooting

### Common Issues

#### Extension Not Working
1. **Check if the platform is supported** - See the supported platforms list above
2. **Verify settings** - Open the popup and ensure "Enable for this website" is checked
3. **Check permissions** - Make sure the extension has permissions for the current site
4. **Refresh the page** - Sometimes a page refresh helps with detection
5. **Check browser compatibility** - Currently optimized for Firefox (Manifest V3)
6. **Clear browser cache** - Old cached data might interfere with detection

#### Series Not Detected
1. **Wait a moment** - Detection can take a few seconds on complex pages
2. **Navigate to a video page** - Make sure you're on an actual content page, not browsing
3. **Check for video elements** - Some platforms need an active video player
4. **Try different content** - Some shows might have non-standard page structures
5. **Check verbose logging** - Enable in settings to see detailed detection information

#### Settings Not Saving
1. **Check storage permissions** - Ensure the extension has storage permissions
2. **Check Firefox Sync** - Verify your Firefox account sync is working
3. **Try local storage** - The extension automatically falls back to local storage if sync fails
4. **Disable and re-enable** - Sometimes helps reset the storage system
5. **Check disk space** - Ensure you have enough storage space

#### Buttons Not Being Clicked
1. **Check series settings** - Verify the specific skip options are enabled for the current series
2. **Check timing** - Some buttons only appear at specific times during playback
3. **Check button visibility** - Extension only clicks visible, clickable buttons
4. **Platform-specific issues** - Some platforms might have changed their button structures
5. **Check cooldown period** - Extension has a 1-second cooldown between clicks to prevent spam

### Debug Information
Enable "Verbose Logging" in the extension popup to see detailed information about:
- Series detection attempts and results
- Button scanning and matching results
- Setting changes and storage operations
- Platform-specific logic execution
- Event triggers and timing information
- Error states and recovery attempts

You can access debug information by:
1. Opening the extension popup
2. Enabling "Verbose Logging"
3. Opening browser developer tools (F12)
4. Checking the Console tab for detailed logs
5. Refreshing the page to see initialization logs

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
- **New Platform Support** - Add support for additional streaming services (Disney+ Hotstar, Stan, Crave, etc.)
- **Language Translations** - Expand multi-language support for button detection and UI
- **Bug Fixes** - Improve reliability and edge case handling across platforms
- **Performance Optimization** - Enhance detection speed and reduce memory usage
- **UI/UX Improvements** - Enhance the popup interface and user experience
- **Documentation** - Improve setup guides and troubleshooting documentation
- **Testing** - Cross-platform testing and compatibility verification
- **Accessibility** - Improve support for users with disabilities

---

## 📄 License

This project is licensed under a custom License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- **Streaming Platforms** - For providing the entertainment we love to watch
- **Firefox Community** - For excellent extension development tools and documentation
- **Open Source Contributors** - For inspiration and code patterns
- **Beta Testers** - For helping identify and fix issues across different platforms

---

## 📞 Support & Community

- **Issues** - Report bugs and request features on [GitHub Issues](https://github.com/Nick190401/VideoPlayerSkipper/issues)
- **Discussions** - Join conversations on [GitHub Discussions](https://github.com/Nick190401/VideoPlayerSkipper/discussions)
- **Updates** - Follow the project for updates and new releases
- **Documentation** - Check the [Wiki](https://github.com/Nick190401/VideoPlayerSkipper/wiki) for detailed guides
- **Security** - Report security issues privately via GitHub Security Advisories

### Frequently Asked Questions

**Q: Does this extension work with all Netflix regions?**
A: Yes, Smart Skip is designed to work with Netflix in all regions and languages.

**Q: Will this extension slow down my browsing?**
A: No, the extension uses efficient detection algorithms and only activates on supported streaming platforms.

**Q: Can I disable the extension for specific shows?**
A: Yes, you can configure series-specific settings through the popup interface.

**Q: Does this extension collect any personal data?**
A: No, Smart Skip only stores your preferences locally and doesn't collect or transmit any personal data.

**Q: Why doesn't it work on [Platform X]?**
A: We're continuously adding support for new platforms. Check our GitHub issues to request new platform support.

---

## 📋 Changelog

### Version 1.1.6 (Current)
- **Enhanced Series Detection** - Improved accuracy across all platforms
- **Performance Optimizations** - Reduced memory usage and faster button detection
- **Code Quality** - Cleaned up codebase for better maintainability
- **Bug Fixes** - Resolved edge cases in series detection and button clicking

### Version 1.1.5
- **Multi-language Support** - Added support for 12+ languages
- **Platform Expansion** - Added Twitch, Vimeo, and Dailymotion support
- **Settings Improvements** - Enhanced popup interface and settings management

### Version 1.1.0
- **Major Rewrite** - Complete redesign of detection algorithms
- **Cross-Device Sync** - Added Firefox Sync support for settings
- **Enhanced Netflix Support** - Improved series and episode detection

### Version 1.0.0
- **Initial Release** - Basic skip functionality for major platforms
- **Core Features** - Skip intro, recap, credits, and ads
- **Platform Support** - Netflix, Disney+, Prime Video, YouTube

---

<div align="center">

**Enjoy uninterrupted streaming! 🍿**

*Made with ❤️ for binge-watchers everywhere*

</div>
