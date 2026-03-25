[<img width="1200" height="629" alt="img_v3_02vs_10766e34-358b-4917-a6fa-bf95a76dfb5g" src="https://github.com/user-attachments/assets/7e79e92f-4b21-4241-b206-ea1cb886f557" />](https://www.scrapeless.com/en/product/scraping-browser)

<p align="center">
  <strong>Scrapeless OpenClaw skill for scraping ChatGPT, Gemini, Perplexity, and Grok responses.</strong><br/>
</p>

  <p align="center">
    <a href="https://www.youtube.com/@Scrapeless" target="_blank">
      <img src="https://img.shields.io/badge/Follow%20on%20YouTuBe-FF0033?style=for-the-badge&logo=youtube&logoColor=white" alt="Follow on YouTuBe" />
    </a>
    <a href="https://discord.com/invite/xBcTfGPjCQ" target="_blank">
      <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord" />
    </a>
    <a href="https://x.com/Scrapelessteam" target="_blank">
      <img src="https://img.shields.io/badge/Follow%20us%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow us on X" />
    </a>
    <a href="https://www.reddit.com/r/Scrapeless" target="_blank">
      <img src="https://img.shields.io/badge/Join%20us%20on%20Reddit-FF4500?style=for-the-badge&logo=reddit&logoColor=white" alt="Join us on Reddit" />
    </a> 
    <a href="https://app.scrapeless.com/passport/register?utm_source=official&utm_term=githubopen" target="_blank">
      <img src="https://img.shields.io/badge/Official%20Website-12A594?style=for-the-badge&logo=google-chrome&logoColor=white" alt="Official Website"/>
    </a>
  </p>

---

# 🌐 Scrapeless Openclaw Scraping Browser Skill: The Cloud Browser Engine for AI Agents


## Overview

The **Scraping Browser Skill** is a high-performance, cloud-hosted browser automation CLI specifically engineered for **AI Agents** and **OpenClaw** workflows. Powered by Scrapeless, it eliminates the overhead of local headless browsers while providing industry-leading bypass capabilities for the most sophisticated anti-bot systems.

## 🚀 Why Use Scraping Browser Skill?

Most AI agents fail when they hit a login wall, a CAPTCHA, or a Cloudflare challenge. Traditional Puppeteer/Playwright setups require massive local resources and constant maintenance of browser fingerprints. 

**The Scrapeless Advantage:**
*   **AI-Native Navigation:** Optimized for LLM understanding with `snapshot -i` (Interactive Element Discovery).
*   **Invisible by Design:** Built-in stealth browser fingerprinting and automatic rotation.
*   **Bypass Anything:** Native support for Cloudflare Turnstile, reCAPTCHA, and HCaptcha.
*   **Infrastructure-Free:** Run 100+ concurrent browser sessions without heating up your server.
*   **Global Presence:** Integrated residential proxies for geo-restricted content access.

## ✨ Core Features

- 🌐 **Web Navigation**: Open and browse any website
- 📝 **Form Operations**: Fill out forms and submit data
- 👆 **Element Interaction**: Click buttons, links, and other elements
- 📷 **Screenshots**: Capture full page or specific elements
- 📊 **Data Extraction**: Get text, links, and other data from web pages
- 🔧 **Web App Testing**: Automate testing of web application functionality
- 🌍 **Proxy Support**: Use residential proxies for global access
- 🛡️ **Anti-detection**: Built-in browser fingerprinting and anti-detection features

## 📦 Quick Start

### Installation

```bash
# Global installation
npm install -g scrapeless-scraping-browser
```

### Configuration

Before using, you need to set up your Scrapeless API key:

```bash
# Method 1: Config file (recommended)
scrapeless-scraping-browser config set apiKey your_api_token_here

# Method 2: Environment variable
export SCRAPELESS_API_KEY=your_api_token_here
```

Get your API token from: [Scrapeless Website](https://app.scrapeless.com)

## 💡 Usage Examples

### Basic Navigation(AI Agent Interaction Flow)

```bash
# Open a website
scrapeless-scraping-browser open https://example.com

# Get page title
scrapeless-scraping-browser get title

# Take screenshot
scrapeless-scraping-browser screenshot
```

### Form Operations(AI Agent Interaction Flow)

```bash
# Open login page
scrapeless-scraping-browser open https://example.com/login

# Get interactive elements
scrapeless-scraping-browser snapshot -i

# Fill form
scrapeless-scraping-browser fill @e1 "username"
scrapeless-scraping-browser fill @e2 "password"

# Click login button
scrapeless-scraping-browser click @e3
```

### Data & Visual Extraction

```bash
# Open data page
scrapeless-scraping-browser open https://example.com/data

# Get interactive elements
scrapeless-scraping-browser snapshot -i

# Extract text
scrapeless-scraping-browser get text @e5
```

### Session Management((Long-running Tasks))

```bash
# Create session
scrapeless-scraping-browser new-session --name "my-session" --ttl 1800

# List sessions
scrapeless-scraping-browser sessions

# Close session
scrapeless-scraping-browser close
```

## 🛠️ Core Commands

| Command | Description |
| :--- | :--- |
| `open <url>` | Navigate the cloud browser to a specific URL. |
| `snapshot -i` | **AI Favorite:** Get a list of interactive elements with references. |
| `fill @ref "text"` | Overwrite text in an input field. |
| `click @ref` | Simulate a real human click on an element. |
| `get text @ref` | Extract inner text from an element. |
| `get title` | Retrieve the current page title. |
| `screenshot` | Save a PNG screenshot of the current viewport. |
| `wait` | Wait for network idle and DOM content loaded. |
| `close` | Terminate the current browser session. |

## 🛡️ Enterprise-Grade Capabilities

Unlike standard headless browsers, the Scraping Browser Skill is backed by the **Scrapeless Global Proxy Network**. 
*   **Residential Proxies:** Access content as a local user in 195+ countries.
*   **Dynamic Fingerprinting:** Every session gets a unique, high-reputation browser profile.
*   **Headless-to-Headed:** Toggle visibility for debugging complex flows.

## System Requirements

- Node.js >= 18.0.0
- Valid Scrapeless API key

## 🎁 Start for Free
We believe in our tech. That's why every new account comes with **Free Trial Credits**. 
*   **No Credit Card Required** for initial testing.
*   **Up to 100+ free hours** to benchmark our bypass success rates.

[Join Scrapeless community to **Claim Your Free Credits Now →**](https://discord.gg/stFPK2xKHY)

## 🔗 Related resources
*   **[Scrapeless Scraping Browser Guide](https://docs.scrapeless.com/en/scraping-browser/quickstart/introduction/)**
*   **[Scrapeless LLM Scraper](https://docs.scrapeless.com/en/llm-chat-scraper/quickstart/introduction/)**
*   **[Scrapeless Universal Scraping API](https://docs.scrapeless.com/en/universal-scraping-api/quickstart/introduction/)**
*   **[Scrapeless WebUnlocker](https://github.com/scrapeless-ai/webunlocker-skill)**

##  Contact Us

For questions, suggestions, or collaboration inquiries, feel free to contact us via:

*   **Official Website:** [Scrapeless.com](https://www.scrapeless.com)
*   **Email:** market@scrapeless.com
*   **Community:** [Join our Discord](https://discord.gg/scrapeless)
*   **Community:** [Join our Telegram](https://t.me/+uELlyZh2JGw1M2Ux)

## License

Apache-2.0
