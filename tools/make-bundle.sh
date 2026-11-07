#!/usr/bin/env bash
# Paczka instalacyjna (D34): dist/solargraf-<wersja>.tar.gz z zatwierdzonego HEAD.
# Zawiera tylko pliki śledzone przez Git (bez .env, node_modules, sekretów lokalnych).
#
#   ./tools/make-bundle.sh
#   scp dist/solargraf-<wersja>.tar.gz użytkownik@serwer:
#   (na serwerze) tar -xzf solargraf-<wersja>.tar.gz && sudo ./solargraf/deploy/install.sh install

set -euo pipefail

main() {
	local root version out
	root="$(git rev-parse --show-toplevel)"
	cd "$root"
	if [ -n "$(git status --porcelain)" ]; then
		printf 'UWAGA: niezatwierdzone zmiany nie trafią do paczki (paczka powstaje z HEAD).\n' >&2
	fi
	version="$(git describe --tags --always)"
	out="dist/solargraf-$version.tar.gz"
	mkdir -p dist
	# core.autocrlf=false: skrypty w paczce zawsze z końcami linii LF (także z Windows).
	git -c core.autocrlf=false archive --format=tar.gz --prefix=solargraf/ \
		--add-virtual-file="solargraf/VERSION:$version" -o "$out" HEAD
	sha256sum "$out" >"$out.sha256"
	printf 'Paczka: %s\n' "$out"
	printf 'SHA-256: %s\n' "$(cut -d' ' -f1 "$out.sha256")"
}

main "$@"
