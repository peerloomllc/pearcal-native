# Build the PearCal seeder .s9pk for StartOS 0.3.5.x.
#
#   make            build + verify a universal s9pk (x86_64 + aarch64)
#   make install    install to the server in ~/.embassy/config.yaml
#   make clean      remove build artifacts
#
# The pinned base image is a multi-arch manifest list (amd64 + arm64), so each
# arch tar just pulls its own layer. Building the arm64 tar on an amd64 host runs
# a tiny apt step under qemu emulation, so qemu-user-static (binfmt) must be
# registered. Requires: deno, yq, the StartOS SDK (start-sdk / start-cli), and
# either docker (buildx) OR podman. See scripts/build-image-tar.sh.

PKG_ID := $(shell yq e ".id" < manifest.yaml)
PKG_VERSION := $(shell yq e ".version" < manifest.yaml)
TS_FILES := $(shell find ./scripts -name \*.ts)

# delete a rule's target if its recipe fails partway
.DELETE_ON_ERROR:

all: verify

verify: $(PKG_ID).s9pk
	@start-sdk verify s9pk $(PKG_ID).s9pk
	@echo " Done!"
	@echo "   $(shell du -h $(PKG_ID).s9pk) is ready"

install:
	@if [ ! -f ~/.embassy/config.yaml ]; then \
		echo 'Define  host: https://<server>.local  in ~/.embassy/config.yaml first.'; exit 1; fi
	@echo "\nInstalling to $$(grep -v '^#' ~/.embassy/config.yaml | cut -d'/' -f3) ...\n"
	@[ -f $(PKG_ID).s9pk ] || $(MAKE)
	@start-cli package install $(PKG_ID).s9pk

clean:
	rm -rf docker-images
	rm -f $(PKG_ID).s9pk
	rm -f scripts/embassy.js

# Bundle the TS procedures (health, config, migrations, properties) into the
# single embassy.js the s9pk loads.
scripts/embassy.js: $(TS_FILES)
	deno run --allow-read --allow-write --allow-env --allow-net scripts/bundle.ts

# Build a per-arch runtime image and export it as a docker-archive tar the packer
# loads, tagged start9/<id>/main:<version>. Uses docker if present, else podman +
# a RepoTags normalization (see scripts/build-image-tar.sh). The tar name
# (x86_64 / aarch64) selects the build --platform.
docker-images/x86_64.tar: Dockerfile docker_entrypoint.sh scripts/build-image-tar.sh
	bash scripts/build-image-tar.sh $(PKG_ID) $(PKG_VERSION) docker-images/x86_64.tar linux/amd64

docker-images/aarch64.tar: Dockerfile docker_entrypoint.sh scripts/build-image-tar.sh
	bash scripts/build-image-tar.sh $(PKG_ID) $(PKG_VERSION) docker-images/aarch64.tar linux/arm64

# Universal s9pk carries both arch images; the manifest's hardware-requirements
# lists x86_64 + aarch64 so StartOS installs the right one per server.
$(PKG_ID).s9pk: manifest.yaml instructions.md icon.png LICENSE scripts/embassy.js docker-images/x86_64.tar docker-images/aarch64.tar
	@echo "start-sdk: packing $(PKG_ID) v$(PKG_VERSION) (x86_64 + aarch64) ..."
	@start-sdk pack
