PORT ?= 8080
VENV ?= .venv
PY   := $(VENV)/bin/python
PIP  := $(VENV)/bin/pip

.PHONY: help install run tunnel dev clean

help:
	@echo "Targets:"
	@echo "  make install   create .venv and install requirements"
	@echo "  make run       run the bot + game server (foreground)"
	@echo "  make tunnel    expose http://localhost:$(PORT) via cloudflared quick tunnel"
	@echo "  make dev       run bot.py and tunnel together"
	@echo "  make clean     remove .venv and tunnel.log"

$(VENV)/bin/activate: requirements.txt
	python3 -m venv $(VENV)
	$(PIP) install -U pip
	$(PIP) install -r requirements.txt
	@touch $(VENV)/bin/activate

install: $(VENV)/bin/activate

run: install
	$(PY) bot.py

# `cloudflared tunnel --url ...` prints its trycloudflare.com URL to stderr.
# We tee everything to tunnel.log so it's easy to grep for the URL after
# the fact, while still streaming live to the terminal.
tunnel:
	@command -v cloudflared >/dev/null 2>&1 || { \
		echo "cloudflared not found. Install: curl -L -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x ~/.local/bin/cloudflared"; \
		exit 1; }
	@echo ">> tunneling http://localhost:$(PORT)  (logs -> tunnel.log)"
	@cloudflared tunnel --no-autoupdate --url http://localhost:$(PORT) 2>&1 | tee tunnel.log

dev: install
	@echo ">> starting bot.py and tunnel together (Ctrl+C to stop both)"
	@( $(PY) bot.py & echo $$! > .bot.pid ) && \
	  trap 'kill $$(cat .bot.pid) 2>/dev/null; rm -f .bot.pid' EXIT INT TERM; \
	  $(MAKE) tunnel

clean:
	rm -rf $(VENV) tunnel.log .bot.pid
