CONFIG_HOME ?= $(if $(XDG_CONFIG_HOME),$(XDG_CONFIG_HOME),$(HOME)/.config)
CONFIG_DIR ?= $(CONFIG_HOME)/opencode-pocket
ARCH_ROOT ?= $(CURDIR)/dist/arch
ARCH_PKGBUILD_DIR := packaging/arch
ARCH_PKGBUILD := $(ARCH_PKGBUILD_DIR)/PKGBUILD
ARCH_WORK_DIR := $(ARCH_ROOT)/makepkg
ARCH_LOCAL_SOURCE := $(ARCH_WORK_DIR)/opencode-pocket-local.tar.gz
MAKEPKG ?= makepkg
NAMCAP ?= namcap

help:
	@printf '%s\n' \
		'make config        Create env and env.dev user configs when absent' \
		'make start         Start with the default env profile' \
		'make dev           Start watch mode with the env.dev profile' \
		'make test          Run application and plugin tests' \
		'make check         Run application and plugin syntax checks' \
		'make verify        Run all tests and syntax checks' \
		'make package       Build the Arch package under dist/arch' \
		'make arch-install  Build and install the Arch package' \
		'make arch-check    Validate the PKGBUILD and package with namcap' \
		'make package-clean Remove Arch package build artifacts'

config:
	@mkdir -p "$(CONFIG_DIR)"
	@if [ ! -e "$(CONFIG_DIR)/env" ]; then install -m 600 .env.example "$(CONFIG_DIR)/env"; printf 'Created %s\n' "$(CONFIG_DIR)/env"; else printf 'Kept existing %s\n' "$(CONFIG_DIR)/env"; fi
	@if [ ! -e "$(CONFIG_DIR)/env.dev" ]; then install -m 600 .env.dev.example "$(CONFIG_DIR)/env.dev"; printf 'Created %s\n' "$(CONFIG_DIR)/env.dev"; else printf 'Kept existing %s\n' "$(CONFIG_DIR)/env.dev"; fi

start:
	bun run start

dev:
	bun run dev

test:
	bun test

check:
	bun run check
	bun run --cwd packages/opencode-pocket-plugin check

verify: test check

package: arch-package

arch-package: verify
	@mkdir -p "$(ARCH_ROOT)/build" "$(ARCH_ROOT)/packages" "$(ARCH_ROOT)/sources" "$(ARCH_WORK_DIR)"
	@rm -f "$(ARCH_ROOT)"/packages/opencode-pocket-git-*.pkg.tar.*
	@install -m 644 "$(ARCH_PKGBUILD)" "$(ARCH_WORK_DIR)/PKGBUILD"
	@tar --exclude='./.git' --exclude='./node_modules' --exclude='./dist' --transform='s,^\.,opencode-pocket,' -czf "$(ARCH_LOCAL_SOURCE)" .
	@cd "$(ARCH_WORK_DIR)" && OPENCODE_POCKET_LOCAL_SOURCE=1 BUILDDIR="$(ARCH_ROOT)/build" PKGDEST="$(ARCH_ROOT)/packages" SRCDEST="$(ARCH_ROOT)/sources" $(MAKEPKG) --cleanbuild --force

arch-install: arch-package
	sudo pacman -U "$(ARCH_ROOT)"/packages/opencode-pocket-git-*.pkg.tar.zst

arch-check: arch-package
	@command -v "$(NAMCAP)" >/dev/null || { printf 'namcap is required for arch-check\n' >&2; exit 1; }
	$(NAMCAP) "$(ARCH_PKGBUILD)" "$(ARCH_ROOT)"/packages/opencode-pocket-git-*.pkg.tar.zst

package-clean:
	rm -rf "$(ARCH_ROOT)"

.PHONY: help config start dev test check verify package arch-package arch-install arch-check package-clean
