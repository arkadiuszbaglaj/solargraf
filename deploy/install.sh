#!/usr/bin/env bash
# SolarGraf (nazwa robocza) — instalator v1, wersja dev (D18, D34).
#
#   sudo ./deploy/install.sh install [--yes] [--dry-run] [--dir DIR] [--address ADRES]
#   sudo solargraf status
#   sudo solargraf uninstall [--purge] [--yes]
#
# Zasady (docs/SECURITY.md, „Instalator”): sekrety tylko w pliku 600, nigdy na ekranie ani
# w logu; Docker wyłącznie z oficjalnego repozytorium i po potwierdzeniu; skrypt nie zmienia
# zapory ani przekierowań portów. Cała logika w funkcjach — `main` wywoływane na końcu pliku,
# więc częściowo pobrany skrypt niczego nie wykona.

set -euo pipefail

readonly PRODUCT="solargraf"
readonly DEFAULT_DIR="/opt/solargraf"
readonly CLI_LINK="/usr/local/bin/solargraf"
readonly MIN_RAM_MB=1024
readonly RECOMMENDED_RAM_MB=2048
readonly MIN_DISK_MB=5120
readonly HEALTH_TIMEOUT_S=300

DRY_RUN=0
ASSUME_YES=0
PURGE=0
INSTALL_DIR="$DEFAULT_DIR"
ADDRESS=""
LOG_FILE=""
WARNINGS=0

# --- wyjście i log ---------------------------------------------------------------------------

log_line() {
	if [ -n "$LOG_FILE" ]; then
		printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"
	fi
}

say() {
	printf '%s\n' "$*"
	log_line "$*"
}

warn() {
	WARNINGS=$((WARNINGS + 1))
	printf 'UWAGA: %s\n' "$*" >&2
	log_line "UWAGA: $*"
}

die() {
	printf 'BŁĄD: %s\n' "$*" >&2
	log_line "BŁĄD: $*"
	exit 1
}

# Uruchamia polecenie albo, w trybie --dry-run, tylko je pokazuje. Argumenty nie mogą
# zawierać sekretów (są logowane).
run() {
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[dry-run] %s\n' "$*"
		return 0
	fi
	log_line "$ $*"
	"$@"
}

confirm() {
	local question="$1" answer
	if [ "$ASSUME_YES" -eq 1 ]; then
		return 0
	fi
	if [ ! -t 0 ]; then
		die "$question — wymagane potwierdzenie. Uruchom w terminalu albo dodaj --yes."
	fi
	read -r -p "$question [t/N] " answer
	case "$answer" in
	t | T | tak | TAK | y | Y | yes) return 0 ;;
	*) return 1 ;;
	esac
}

usage() {
	cat <<'EOF'
Użycie:
  install.sh install   [--yes] [--dry-run] [--dir KATALOG] [--address ADRES]
  install.sh status    [--dir KATALOG]
  install.sh setup-link [--dir KATALOG]   nowy jednorazowy link do pierwszego konta
  install.sh uninstall [--purge] [--yes] [--dir KATALOG]

  --dry-run   pokaż plan i wynik kontroli, nic nie zmieniaj
  --yes       nie pytaj o potwierdzenie (np. instalacja Dockera)
  --dir       katalog instalacji (domyślnie /opt/solargraf)
  --address   adres IPv4 lub nazwa hosta w LAN (domyślnie wykrywany)
  --purge     przy uninstall: usuń także dane (baza, certyfikaty, katalog)
EOF
}

# --- pomocnicze ------------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

script_path() { readlink -f "${BASH_SOURCE[0]}"; }

source_root() { dirname "$(dirname "$(script_path)")"; }

require_root() {
	if [ "$(id -u)" -ne 0 ]; then
		die "Uruchom jako root (sudo)."
	fi
}

valid_address() {
	local a="$1"
	[[ "$a" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || [[ "$a" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]]
}

detect_address() {
	local a=""
	if have ip; then
		# Nie wysyła pakietów — tylko pyta tablicę routingu o adres źródłowy.
		a="$(ip -4 -o route get 192.0.2.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"
	fi
	if [ -z "$a" ] && have hostname; then
		a="$(hostname -I 2>/dev/null | awk '{print $1}')"
	fi
	printf '%s' "$a"
}

site_addresses() {
	local list="https://localhost" host=""
	if [ -n "$ADDRESS" ]; then
		list="$list, https://$ADDRESS"
	fi
	if have hostname; then
		host="$(hostname 2>/dev/null || true)"
	fi
	if [ -n "$host" ] && [ "$host" != "localhost" ] && [ "$host" != "$ADDRESS" ] && valid_address "$host"; then
		list="$list, https://$host"
	fi
	printf '%s' "$list"
}

compose() {
	docker compose -p "$PRODUCT" \
		-f "$INSTALL_DIR/src/deploy/compose.yaml" \
		--env-file "$INSTALL_DIR/.env" "$@"
}

new_secret() {
	# 32 bajty z jądra → base64 bez znaków specjalnych (bezpieczne w .env i URL bazy).
	head -c 32 /dev/urandom | base64 | tr -d '/+=\n'
}

# --- kontrola systemu (O14) ------------------------------------------------------------------

OS_ID=""
OS_VERSION=""
OS_CODENAME=""

check_system() {
	say "== Kontrola systemu"
	[ -r /etc/os-release ] || die "Brak /etc/os-release — nieobsługiwany system."
	# shellcheck disable=SC1091
	. /etc/os-release
	OS_ID="${ID:-}"
	OS_VERSION="${VERSION_ID:-}"
	OS_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
	case "$OS_ID:$OS_VERSION" in
	debian:12 | debian:13 | ubuntu:24.04 | raspbian:12 | raspbian:13)
		say "System: ${PRETTY_NAME:-$OS_ID $OS_VERSION} — wspierany." ;;
	debian:* | ubuntu:* | raspbian:*)
		warn "System ${PRETTY_NAME:-$OS_ID $OS_VERSION} nie jest na liście wspieranych (Debian 12/13, Ubuntu 24.04, Raspberry Pi OS 64-bit)." ;;
	*)
		die "Nieobsługiwany system: ${PRETTY_NAME:-$OS_ID}. Wspierane: Debian 12/13, Ubuntu 24.04, Raspberry Pi OS 64-bit." ;;
	esac

	local arch dpkg_arch
	arch="$(uname -m)"
	case "$arch" in
	x86_64 | aarch64) ;;
	*) die "Nieobsługiwana architektura: $arch (wymagane amd64 lub arm64)." ;;
	esac
	dpkg_arch="$(dpkg --print-architecture 2>/dev/null || echo unknown)"
	case "$dpkg_arch" in
	amd64 | arm64) say "Architektura: $dpkg_arch." ;;
	*) die "System użytkowy $dpkg_arch nie jest 64-bitowy (wymagany amd64 lub arm64)." ;;
	esac

	local ram_mb
	ram_mb=$(($(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024))
	if [ "$ram_mb" -lt "$MIN_RAM_MB" ]; then
		die "Za mało pamięci RAM: ${ram_mb} MB (minimum ${MIN_RAM_MB} MB)."
	elif [ "$ram_mb" -lt "$RECOMMENDED_RAM_MB" ]; then
		warn "RAM ${ram_mb} MB — zalecane co najmniej ${RECOMMENDED_RAM_MB} MB (budowanie obrazów może być wolne)."
	else
		say "RAM: ${ram_mb} MB."
	fi

	local probe="$INSTALL_DIR" free_mb
	while [ ! -d "$probe" ]; do probe="$(dirname "$probe")"; done
	for path in "$probe" /var/lib; do
		free_mb="$(df -Pm "$path" | awk 'NR==2 {print $4}')"
		if [ "$free_mb" -lt "$MIN_DISK_MB" ]; then
			die "Za mało miejsca w $path: ${free_mb} MB (minimum ${MIN_DISK_MB} MB)."
		fi
		say "Wolne miejsce w $path: ${free_mb} MB."
	done

	if have systemd-detect-virt && [ "$(systemd-detect-virt -c 2>/dev/null || true)" = "lxc" ]; then
		warn "Kontener LXC: Docker wymaga włączonej opcji nesting (Proxmox: Options → Features)."
	fi
	if findmnt -no SOURCE / 2>/dev/null | grep -q '^/dev/mmcblk'; then
		warn "System na karcie SD — baza danych szybko ją zużyje. Zalecany dysk SSD/USB."
	fi

	check_ports
	check_internet
}

proxy_running() {
	have docker && [ -f "$INSTALL_DIR/.env" ] &&
		[ -n "$(compose ps -q --status running proxy 2>/dev/null || true)" ]
}

check_ports() {
	if ! have ss; then
		warn "Brak polecenia ss — nie sprawdzono, czy porty 80 i 443 są wolne."
		return 0
	fi
	if proxy_running; then
		say "Porty 80/443: zajęte przez istniejącą instalację $PRODUCT."
		return 0
	fi
	local port busy=""
	for port in 80 443; do
		if [ -n "$(ss -Hltn "sport = :$port" 2>/dev/null)" ]; then
			busy="$busy $port"
		fi
	done
	if [ -n "$busy" ]; then
		die "Zajęte porty:$busy. Zatrzymaj usługę, która ich używa (np. inny serwer WWW)."
	fi
	say "Porty 80 i 443: wolne."
}

check_internet() {
	if ! have curl; then
		warn "Brak curl — nie sprawdzono dostępu do Internetu (potrzebny do pobrania obrazów)."
		return 0
	fi
	# Rejestr odpowiada 401 bez logowania — liczy się samo połączenie TLS.
	if curl -sS --max-time 10 -o /dev/null https://registry-1.docker.io/v2/ 2>/dev/null; then
		say "Dostęp do rejestru obrazów: OK."
	else
		warn "Brak dostępu do registry-1.docker.io — pobieranie obrazów się nie powiedzie."
	fi
}

# --- Docker ----------------------------------------------------------------------------------

docker_ready() { have docker && docker compose version >/dev/null 2>&1; }

ensure_docker() {
	if docker_ready; then
		say "Docker: $(docker --version)."
		return 0
	fi
	if have docker; then
		die "Docker jest zainstalowany, ale brak wtyczki Compose v2 (docker compose). Zainstaluj docker-compose-plugin."
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		say "Docker: brak — instalator zaproponuje instalację z oficjalnego repozytorium Dockera."
		return 0
	fi
	confirm "Brak Dockera. Zainstalować Docker Engine i Compose z oficjalnego repozytorium download.docker.com?" ||
		die "Docker jest wymagany. Przerwano."
	# Raspberry Pi OS 64-bit korzysta z repozytorium dla Debiana.
	local repo_id="$OS_ID"
	[ "$repo_id" = "raspbian" ] && repo_id="debian"
	[ -n "$OS_CODENAME" ] || die "Nie rozpoznano nazwy kodowej systemu (VERSION_CODENAME)."
	run apt-get update
	run apt-get install -y ca-certificates curl
	run install -m 0755 -d /etc/apt/keyrings
	run curl -fsSL "https://download.docker.com/linux/$repo_id/gpg" -o /etc/apt/keyrings/docker.asc
	run chmod a+r /etc/apt/keyrings/docker.asc
	printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
		"$(dpkg --print-architecture)" "$repo_id" "$OS_CODENAME" >/etc/apt/sources.list.d/docker.list
	log_line "zapisano /etc/apt/sources.list.d/docker.list"
	run apt-get update
	run apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	run systemctl enable --now docker
	docker_ready || die "Instalacja Dockera nie powiodła się."
	say "Docker zainstalowany: $(docker --version)."
}

# --- instalacja ------------------------------------------------------------------------------

copy_sources() {
	local src
	src="$(source_root)"
	[ -f "$src/deploy/compose.yaml" ] || die "Nie znaleziono deploy/compose.yaml obok skryptu ($src)."
	if [ "$src" = "$INSTALL_DIR/src" ]; then
		say "Źródła: używam zainstalowanej kopii."
		return 0
	fi
	say "Kopiuję źródła do $INSTALL_DIR/src."
	rm -rf "$INSTALL_DIR/src.new" "$INSTALL_DIR/src.old"
	mkdir -p "$INSTALL_DIR/src.new"
	tar -C "$src" --exclude=./.git --exclude='*/node_modules' --exclude='./web/dist' --exclude='*/.venv' \
		--exclude='./deploy/.env' -cf - . | tar -C "$INSTALL_DIR/src.new" -xf -
	if [ -d "$INSTALL_DIR/src" ]; then
		mv "$INSTALL_DIR/src" "$INSTALL_DIR/src.old"
	fi
	mv "$INSTALL_DIR/src.new" "$INSTALL_DIR/src"
	rm -rf "$INSTALL_DIR/src.old"
	chmod 0755 "$INSTALL_DIR/src/deploy/install.sh"
}

write_env() {
	local env="$INSTALL_DIR/.env" addresses
	addresses="$(site_addresses)"
	if [ ! -f "$env" ]; then
		say "Generuję sekrety w $env (uprawnienia 600)."
		(
			umask 077
			{
				printf '# Wygenerowane przez instalator %s. Nie udostępniaj tego pliku.\n' "$PRODUCT"
				printf 'SOLARGRAF_DB_PASSWORD=%s\n' "$(new_secret)"
			} >"$env"
		)
	else
		say "Plik $env istnieje — zachowuję sekrety."
	fi
	# Adresy mogą się zmienić (DHCP) — odświeżane przy każdym uruchomieniu.
	local tmp="$env.tmp"
	(
		umask 077
		grep -v -e '^SOLARGRAF_SITE_ADDRESSES=' -e '^SOLARGRAF_PUBLIC_ADDRESS=' "$env" >"$tmp" || true
		printf 'SOLARGRAF_SITE_ADDRESSES=%s\n' "$addresses" >>"$tmp"
		printf 'SOLARGRAF_PUBLIC_ADDRESS=%s\n' "${ADDRESS:-localhost}" >>"$tmp"
	)
	mv "$tmp" "$env"
	chmod 600 "$env"
	say "Adresy TLS: $addresses"
}

wait_healthy() {
	say "== Czekam na gotowość (do ${HEALTH_TIMEOUT_S} s)"
	local waited=0
	until curl -fsk --max-time 5 -o /dev/null https://localhost/api/health/ready 2>/dev/null; do
		if [ "$waited" -ge "$HEALTH_TIMEOUT_S" ]; then
			compose ps >&2 || true
			die "Aplikacja nie zgłosiła gotowości. Logi: docker compose -p $PRODUCT logs"
		fi
		sleep 5
		waited=$((waited + 5))
	done
	say "Aplikacja gotowa (https://localhost/api/health/ready = 200)."
}

export_ca() {
	local target="$INSTALL_DIR/$PRODUCT-ca.crt" tries=0
	until compose cp proxy:/data/caddy/pki/authorities/local/root.crt "$target" >/dev/null 2>&1; do
		tries=$((tries + 1))
		[ "$tries" -lt 12 ] || {
			warn "Nie udało się skopiować certyfikatu CA z proxy."
			return 0
		}
		sleep 5
	done
	chmod 644 "$target"
	say "Certyfikat CA: $target (zaimportuj go w przeglądarce jako zaufany urząd, aby usunąć ostrzeżenie)."
}

print_setup_link() {
	local token host="${ADDRESS:-localhost}"
	if token="$(compose exec -T api solargraf-admin setup-token 2>/dev/null)" && [ -n "$token" ]; then
		# Link tylko na ekran operatora — nigdy do logu (D31, SECURITY.md).
		printf '\nPierwsze konto (jednorazowy link, ważny 1 h):\n  https://%s/setup?token=%s\n' "$host" "$token"
		printf 'Nowy link: sudo %s setup-link\n' "$CLI_LINK"
		log_line "wydano jednorazowy link pierwszej konfiguracji (treść pominięta)"
	else
		say "System jest już skonfigurowany — link pierwszej konfiguracji nie jest potrzebny."
	fi
}

show_plan() {
	local existing="$1"
	say "== Plan"
	if [ "$existing" -eq 1 ]; then
		say "- istniejąca instalacja w $INSTALL_DIR: naprawa/aktualizacja z zachowaniem sekretów i danych"
	else
		say "- nowa instalacja w $INSTALL_DIR"
	fi
	say "- źródła z $(source_root) → $INSTALL_DIR/src"
	say "- sekrety w $INSTALL_DIR/.env (600), adresy: $(site_addresses)"
	say "- budowa obrazów i start: db, migrate, api, proxy (porty 80 i 443)"
	say "- polecenie $CLI_LINK"
	say "- jednorazowy link do pierwszego konta"
}

cmd_install() {
	if [ "$DRY_RUN" -eq 0 ]; then
		require_root
	fi
	if [ -z "$ADDRESS" ]; then
		ADDRESS="$(detect_address)"
		[ -n "$ADDRESS" ] || warn "Nie wykryto adresu w LAN — aplikacja będzie dostępna tylko jako https://localhost. Użyj --address."
	fi
	if [ -n "$ADDRESS" ] && ! valid_address "$ADDRESS"; then
		die "Nieprawidłowy adres: $ADDRESS"
	fi
	if [ "$DRY_RUN" -eq 0 ]; then
		mkdir -p "$INSTALL_DIR"
		chmod 0750 "$INSTALL_DIR"
		LOG_FILE="$INSTALL_DIR/install.log"
		(umask 077 && touch "$LOG_FILE")
		log_line "--- install"
	fi

	local existing=0
	[ -f "$INSTALL_DIR/.env" ] && existing=1
	check_system
	ensure_docker
	show_plan "$existing"
	if [ "$DRY_RUN" -eq 1 ]; then
		say "== Tryb --dry-run: nic nie zmieniono (ostrzeżenia: $WARNINGS)."
		return 0
	fi

	copy_sources
	write_env
	say "== Budowa obrazów i uruchomienie (pierwsza budowa może potrwać kilka–kilkanaście minut)"
	compose up -d --build --remove-orphans
	wait_healthy
	export_ca
	ln -sf "$INSTALL_DIR/src/deploy/install.sh" "$CLI_LINK"
	say "Polecenie: $CLI_LINK (status, uninstall, setup-link)."

	say ""
	say "Gotowe. Adres aplikacji: https://${ADDRESS:-localhost}/"
	print_setup_link
	if [ "$WARNINGS" -gt 0 ]; then
		say "Ostrzeżenia: $WARNINGS (powyżej)."
	fi
}

# --- status, link, odinstalowanie ------------------------------------------------------------

require_installation() {
	[ -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/src/deploy/compose.yaml" ] ||
		die "Brak instalacji w $INSTALL_DIR."
}

cmd_status() {
	require_root
	require_installation
	local version="nieznana"
	[ -f "$INSTALL_DIR/src/VERSION" ] && version="$(cat "$INSTALL_DIR/src/VERSION")"
	say "$PRODUCT (nazwa robocza), wersja: $version, katalog: $INSTALL_DIR"
	compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
	if curl -fsk --max-time 5 -o /dev/null https://localhost/api/health/ready 2>/dev/null; then
		say "Gotowość: OK"
	else
		say "Gotowość: BRAK (sprawdź: docker compose -p $PRODUCT logs)"
	fi
	df -h "$INSTALL_DIR" /var/lib
}

cmd_setup_link() {
	require_root
	require_installation
	ADDRESS="$(sed -n 's/^SOLARGRAF_PUBLIC_ADDRESS=//p' "$INSTALL_DIR/.env" | head -n1)"
	print_setup_link
}

cmd_uninstall() {
	require_root
	require_installation
	LOG_FILE="$INSTALL_DIR/install.log"
	log_line "--- uninstall (purge=$PURGE)"
	if [ "$PURGE" -eq 1 ]; then
		confirm "Usunąć aplikację RAZEM Z DANYMI (baza, certyfikaty, $INSTALL_DIR)? Tej operacji nie da się cofnąć." ||
			die "Przerwano."
		compose down --volumes --remove-orphans
		docker image rm -f solargraf-api:local solargraf-proxy:local >/dev/null 2>&1 || true
		rm -f "$CLI_LINK"
		LOG_FILE=""
		rm -rf "$INSTALL_DIR"
		say "Usunięto aplikację i dane."
	else
		confirm "Zatrzymać i usunąć kontenery aplikacji? Dane i sekrety zostaną zachowane." || die "Przerwano."
		compose down --remove-orphans
		rm -f "$CLI_LINK"
		say "Usunięto kontenery. Dane (wolumeny) i $INSTALL_DIR zostały zachowane."
		say "Ponowna instalacja: sudo $INSTALL_DIR/src/deploy/install.sh install"
	fi
}

# --- wejście ---------------------------------------------------------------------------------

main() {
	local command="${1:-}"
	[ $# -gt 0 ] && shift
	while [ $# -gt 0 ]; do
		case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--yes | -y) ASSUME_YES=1 ;;
		--purge) PURGE=1 ;;
		--dir)
			[ $# -ge 2 ] || die "--dir wymaga ścieżki."
			INSTALL_DIR="$2"
			shift
			;;
		--address)
			[ $# -ge 2 ] || die "--address wymaga wartości."
			ADDRESS="$2"
			shift
			;;
		-h | --help)
			usage
			return 0
			;;
		*) die "Nieznana opcja: $1 (zobacz --help)" ;;
		esac
		shift
	done
	case "$INSTALL_DIR" in
	/*) ;;
	*) die "--dir musi być ścieżką bezwzględną." ;;
	esac
	INSTALL_DIR="${INSTALL_DIR%/}"
	[ -n "$INSTALL_DIR" ] && [ "$INSTALL_DIR" != "/" ] || die "Nieprawidłowy katalog instalacji."

	case "$command" in
	install) cmd_install ;;
	status) cmd_status ;;
	setup-link) cmd_setup_link ;;
	uninstall) cmd_uninstall ;;
	"" | -h | --help | help) usage ;;
	*) die "Nieznane polecenie: $command (zobacz --help)" ;;
	esac
}

main "$@"
