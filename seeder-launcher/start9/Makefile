# Build the PearCal seeder .s9pk for StartOS 0.3.5.x.
#
#   make            build + verify an x86_64 s9pk
#   make install    install to the server in ~/.embassy/config.yaml
#   make clean      remove build artifacts
#
# x86_64-only (see manifest.yaml hardware-requirements): the x86_64 tar pulls the
# amd64 layer from the pinned multi-arch base image. Requires: deno, yq, the
# StartOS SDK (start-sdk / start-cli), and either docker (buildx) OR podman. See
# scripts/build-image-tar.sh.

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

# x86_64-only s9pk (see manifest.yaml hardware-requirements): StartOS serves one
# .s9pk per package, so shipping a single arch halves the download. arm StartOS
# hosts use the multi-arch Docker image instead.
$(PKG_ID).s9pk: manifest.yaml instructions.md icon.png LICENSE scripts/embassy.js docker-images/x86_64.tar
	@echo "start-sdk: packing $(PKG_ID) v$(PKG_VERSION) (x86_64) ..."
	@start-sdk pack
