# Appreciation Bot

A Slack bot that celebrates helpful team members! When someone reacts to a message with `:helpful:`, the bot tracks the count and sends the message author a congratulatory DM with a fun GIF when they hit milestones (1, 5, 10, 20 reactions).

## Features

- Tracks `:helpful:` emoji reactions on messages
- Sends DM notifications at milestone thresholds
- Includes random celebration GIFs from Giphy
- Persists data with SQLite
- Uses Socket Mode for easy local development

## Prerequisites

- Node.js 18+
- A Slack workspace where you can install apps
- A Giphy API key

## Slack App Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Select "From scratch" and give it a name

### Enable Socket Mode

1. Go to **Socket Mode** in the sidebar
2. Enable Socket Mode
3. Create an app-level token with `connections:write` scope
4. Save the token (starts with `xapp-`)

### Configure Bot Token Scopes

Go to **OAuth & Permissions** and add these Bot Token Scopes:

- `channels:history` - View messages in public channels
- `groups:history` - View messages in private channels
- `im:history` - View messages in DMs
- `mpim:history` - View messages in group DMs
- `chat:write` - Send messages
- `im:write` - Start DM conversations
- `reactions:read` - View emoji reactions
- `users:read` - View basic user info

### Enable Events

Go to **Event Subscriptions** and:

1. Enable Events
2. Subscribe to bot events:
   - `reaction_added`
   - `reaction_removed`

### Install the App

1. Go to **Install App**
2. Click "Install to Workspace"
3. Copy the Bot User OAuth Token (starts with `xoxb-`)

### Get Signing Secret

1. Go to **Basic Information**
2. Copy the Signing Secret

## Giphy API Setup

1. Go to [developers.giphy.com](https://developers.giphy.com/)
2. Create an account and app
3. Copy your API key

## Installation

```bash
npm install
```

## Configuration

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Fill in your credentials in `.env`:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret
GIPHY_API_KEY=your-giphy-api-key
```

## Running the Bot

Development mode (with auto-reload):

```bash
npm run dev
```

Production mode:

```bash
npm start
```

## Adding the :helpful: Emoji

If your workspace doesn't have a `:helpful:` emoji:

1. Go to your Slack workspace
2. Click on the emoji picker
3. Click "Add Emoji"
4. Upload an image and name it `helpful`

Or you can modify `REACTION_NAME` in `src/index.js` to use any existing emoji.

## How It Works

1. Someone posts a message in a channel where the bot is present
2. Team members react with `:helpful:`
3. The bot tracks reaction counts in SQLite
4. When counts hit 1, 5, 10, or 20, the message author gets a DM
5. Each threshold only triggers once per message

## Database

The SQLite database (`appreciation.db`) is created automatically in the project root. It stores:

- Message IDs and channel info
- Reaction counts
- Which threshold notifications have been sent

## Troubleshooting

**Bot doesn't respond to reactions:**
- Ensure the bot is invited to channels where you want it to work (`/invite @YourBotName`)
- Check that Socket Mode is enabled and the app token is correct
- Verify the bot has `reactions:read` scope

**No GIFs in messages:**
- Verify your Giphy API key is valid
- Check the console for API errors

**Database errors:**
- Delete `appreciation.db` to reset (you'll lose history)
- Ensure write permissions in the project directory
