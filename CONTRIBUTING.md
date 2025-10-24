# Contributing to GameSentenceMiner (GSM)

Thank you for your interest in contributing to GSM! This guide will help you get started with development.

This guide is **very clearly** AI Written, and lightly edited by me. If you find any oddities or mistakes, please let me know.

## Quick Start

Getting GSM up and running for development is straightforward:

```bash
npm install
npm run start
```

That's it! This will build the TypeScript files and launch the Electron application.

## 📋 Prerequisites

### Node.js Version Management with NVM

**Important**: GSM loosely requires Node.js version 21 (I had 21 installed when I built it). I strongly recommend using Node Version Manager (NVM) to manage your Node.js installation. All I know is that 24 DOES NOT work.

#### Installing NVM

**Windows (nvm-windows):**
1. Download the latest installer from [nvm-windows releases](https://github.com/coreybutler/nvm-windows/releases)
2. Run the installer
3. Restart your terminal

**macOS/Linux:**

https://github.com/nvm-sh/nvm

#### Setting up Node.js 21

Once NVM is installed, set up the correct Node.js version:

```bash
nvm install 21
nvm use 21
```

You can verify your Node.js version with:
```bash
node --version
```

## 🛠️ Development Workflow

### Available Scripts

- `npm run start` - Build and run the application
- `npm run app:dist` - Create distribution build

### Recommended Development Flow

1. **Fork and Clone**
   ```bash
   git clone --recurse-submodules https://github.com/bpwhelan/GameSentenceMiner.git
   cd GameSentenceMiner
   ```
   **Important**: Use `--recurse-submodules` to ensure all dependencies are properly cloned.

2. **Setup Environment**
   ```bash
   nvm use 21
   npm install
   ```

3. **Make Changes**
   - Edit TypeScript files in `electron-src/`
   - Edit Python files in `GameSentenceMiner/` as needed
   - Use `npm run start` to build and test your changes
   - Use `Restart Python App` from app menus to reload Python changes

## 🏗️ Project Structure

```
GameSentenceMiner/
├── electron-src/          # Electron main process and renderer
│   ├── main/              # Main process TypeScript files
│   └── assets/            # HTML, CSS, and static assets
├── GameSentenceMiner/     # Python backend components
├── GSM_Overlay/           # Overlay application
├── texthooker/            # Text hooking functionality
└── dist/                  # Compiled TypeScript output
```

### Python Components

GSM includes Python components that handle OCR, AI integration, and other backend functionality. **Important**: The Python code runs using GSM's managed Python installation, not your system Python. This means:

- Python dependencies are managed by GSM itself
- Local changes to Python files in `GameSentenceMiner/` will be used during development
- No need to install Python packages manually - GSM handles this internally

<!-- ## 🧪 Testing

### Manual Testing

- Test core OCR functionality
- Verify Anki integration works
- Check audio capture features
- Test with different game configurations

## 📝 Code Style

- Follow existing TypeScript/JavaScript conventions
- Use meaningful variable and function names
- Add comments for complex logic
- Ensure proper error handling -->

## 🐛 Bug Reports

When reporting bugs, please include:
- Operating system and version
- Node.js version (`node --version`)
- Steps to reproduce
- Expected vs actual behavior
- Screenshots or error messages if applicable

## 💡 Feature Requests

Before implementing new features:
1. Check existing issues and discussions
2. Open an issue to discuss the feature
3. Get feedback from maintainers
4. Submit a pull request with your implementation

## 🔧 Troubleshooting

### Common Issues

**Build Failures:**
- Ensure you're using Node.js 21: `node --version`
- Clear node_modules and reinstall: `rm -rf node_modules && npm install`

**Electron Not Starting:**
- Check if TypeScript compilation succeeded
- Verify all dependencies are installed
- Check console for error messages

**Python Components Not Working:**
- GSM includes Python components that may need additional setup
- Check the main README for Python-specific requirements

## 📞 Getting Help

- **Discord**: Join our [Discord server](https://discord.gg/yP8Qse6bb8)
- **Issues**: Open a GitHub issue for bugs or feature requests
- **Discussions**: Use GitHub Discussions for general questions

## 🤝 Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Test thoroughly
5. Commit with descriptive messages
6. Push to your fork
7. Open a pull request with a clear description

Thank you for contributing to GameSentenceMiner! Your efforts help make language learning through games more accessible for everyone. 🎮📚

# Logging

In Python:
* info() and errror() are sent to the console
* info(), error(), and debug() are all sent to log file

