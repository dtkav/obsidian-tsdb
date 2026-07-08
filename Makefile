# TSDB Plugin Makefile

PLUGIN_NAME = tsdb
DIST_DIR = dist
BUILD_FILES = main.js manifest.json styles.css
VAULT_PATH ?= 

# Default target
all: build package

# Install dependencies
deps:
	npm install

# Build the plugin
build: deps
	npm run build

# Clean build artifacts
clean:
	rm -rf $(DIST_DIR)
	rm -f main.js

# Create distribution package
package: build
	@echo "Creating distribution package..."
	mkdir -p $(DIST_DIR)/$(PLUGIN_NAME)
	cp $(BUILD_FILES) $(DIST_DIR)/$(PLUGIN_NAME)/
	@echo "Package created in $(DIST_DIR)/$(PLUGIN_NAME)/"
	@echo "Files included:"
	@ls -la $(DIST_DIR)/$(PLUGIN_NAME)/

# Development build with watch
dev:
	npm run dev

# Install to Obsidian vault
# Usage: make install VAULT_PATH=/path/to/your/vault
install: package
	@if [ -z "$(VAULT_PATH)" ]; then \
		echo "Error: VAULT_PATH not specified."; \
		echo "Usage: make install VAULT_PATH=/path/to/your/vault"; \
		exit 1; \
	fi
	@if [ ! -d "$(VAULT_PATH)" ]; then \
		echo "Error: Vault path '$(VAULT_PATH)' does not exist."; \
		exit 1; \
	fi
	@echo "Installing plugin to vault: $(VAULT_PATH)"
	mkdir -p "$(VAULT_PATH)/.obsidian/plugins/$(PLUGIN_NAME)"
	cp $(DIST_DIR)/$(PLUGIN_NAME)/* "$(VAULT_PATH)/.obsidian/plugins/$(PLUGIN_NAME)/"
	@echo "Plugin installed successfully!"
	@echo "Installed files:"
	@ls -la "$(VAULT_PATH)/.obsidian/plugins/$(PLUGIN_NAME)/"
	@echo ""
	@echo "To enable the plugin:"
	@echo "1. Open Obsidian"
	@echo "2. Go to Settings → Community Plugins"
	@echo "3. Enable 'TSDB'"

# Install to vault (alternative with environment variable)
# Usage: VAULT=/path/to/vault make install-env
install-env: package
	@if [ -z "$$VAULT" ]; then \
		echo "Error: VAULT environment variable not set."; \
		echo "Usage: VAULT=/path/to/your/vault make install-env"; \
		exit 1; \
	fi
	@if [ ! -d "$$VAULT" ]; then \
		echo "Error: Vault path '$$VAULT' does not exist."; \
		exit 1; \
	fi
	@echo "Installing plugin to vault: $$VAULT"
	mkdir -p "$$VAULT/.obsidian/plugins/$(PLUGIN_NAME)"
	cp $(DIST_DIR)/$(PLUGIN_NAME)/* "$$VAULT/.obsidian/plugins/$(PLUGIN_NAME)/"
	@echo "Plugin installed successfully!"
	@echo "Installed files:"
	@ls -la "$$VAULT/.obsidian/plugins/$(PLUGIN_NAME)/"

# Uninstall from vault
# Usage: make uninstall VAULT_PATH=/path/to/your/vault
uninstall:
	@if [ -z "$(VAULT_PATH)" ]; then \
		echo "Error: VAULT_PATH not specified."; \
		echo "Usage: make uninstall VAULT_PATH=/path/to/your/vault"; \
		exit 1; \
	fi
	@if [ ! -d "$(VAULT_PATH)/.obsidian/plugins/$(PLUGIN_NAME)" ]; then \
		echo "Plugin not found in vault: $(VAULT_PATH)"; \
		exit 1; \
	fi
	@echo "Uninstalling plugin from vault: $(VAULT_PATH)"
	rm -rf "$(VAULT_PATH)/.obsidian/plugins/$(PLUGIN_NAME)"
	@echo "Plugin uninstalled successfully!"

# Create a release package (zip)
release: package
	@echo "Creating release package..."
	cd $(DIST_DIR) && zip -r $(PLUGIN_NAME)-$(shell date +%Y%m%d).zip $(PLUGIN_NAME)/
	@echo "Release package created: $(DIST_DIR)/$(PLUGIN_NAME)-$(shell date +%Y%m%d).zip"

# Lint the code
lint:
	npm run lint || echo "Linting not configured"

# Type check
typecheck:
	npx tsc --noEmit

# Format code (if prettier is configured)
format:
	npx prettier --write "**/*.{ts,js,json,md}" || echo "Prettier not configured"

# Show help
help:
	@echo "TSDB Plugin Makefile"
	@echo ""
	@echo "Available targets:"
	@echo "  all         - Build and package the plugin (default)"
	@echo "  deps        - Install npm dependencies"
	@echo "  build       - Build the plugin"
	@echo "  package     - Create distribution package in dist/"
	@echo "  dev         - Start development build with watch"
	@echo "  clean       - Clean build artifacts"
	@echo ""
	@echo "Installation targets:"
	@echo "  install     - Install to vault (requires VAULT_PATH)"
	@echo "                Usage: make install VAULT_PATH=/path/to/vault"
	@echo "  install-env - Install using VAULT environment variable"
	@echo "                Usage: VAULT=/path/to/vault make install-env"
	@echo "  uninstall   - Uninstall from vault (requires VAULT_PATH)"
	@echo "                Usage: make uninstall VAULT_PATH=/path/to/vault"
	@echo ""
	@echo "Release targets:"
	@echo "  release     - Create a zip release package"
	@echo ""
	@echo "Development targets:"
	@echo "  lint        - Run linter"
	@echo "  typecheck   - Run TypeScript type checking"
	@echo "  format      - Format code with prettier"
	@echo ""
	@echo "  help        - Show this help message"

# Ensure these targets don't conflict with files
.PHONY: all deps build clean package dev install install-env uninstall release lint typecheck format help

# Quick development workflow
quick-install: build
	@if [ -z "$(VAULT_PATH)" ]; then \
		echo "Error: VAULT_PATH not specified."; \
		echo "Usage: make quick-install VAULT_PATH=/path/to/your/vault"; \
		exit 1; \
	fi
	@echo "Quick installing to vault: $(VAULT_PATH)"
	mkdir -p "$(VAULT_PATH)/.obsidian/plugins/$(PLUGIN_NAME)"
	cp $(BUILD_FILES) "$(VAULT_PATH)/.obsidian/plugins/$(PLUGIN_NAME)/"
	@echo "Quick install complete! Reload Obsidian to see changes."

# Watch and install on changes (requires inotify-tools)
watch-install:
	@if [ -z "$(VAULT_PATH)" ]; then \
		echo "Error: VAULT_PATH not specified."; \
		echo "Usage: make watch-install VAULT_PATH=/path/to/your/vault"; \
		exit 1; \
	fi
	@echo "Watching for changes and auto-installing to $(VAULT_PATH)"
	@echo "Press Ctrl+C to stop watching"
	while inotifywait -e modify,create,delete -r . --exclude='node_modules|\.git|dist' 2>/dev/null; do \
		echo "Changes detected, rebuilding and installing..."; \
		make quick-install VAULT_PATH="$(VAULT_PATH)" || true; \
		sleep 1; \
	done
