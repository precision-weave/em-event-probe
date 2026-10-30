set dotenv-load := true
set shell := ["zsh", "-cu"]
set positional-arguments

# List recipes
default:
    @just --list

# Install dependencies (the private @pw/ui package needs NODE_AUTH_TOKEN)
install:
    npm install

# Start the probe app: just start [board-id] [port]. Arguments override .env, which overrides config.local.json
start *args:
    node app.mjs "$@"
