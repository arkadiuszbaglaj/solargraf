#!/usr/bin/env bash
# SolarGraf (nazwa robocza) — instalator v1, wersja dev (D18, D34).
#
#   curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/solargraf/main/deploy/install.sh | sudo bash -s install
#   sudo ./deploy/install.sh install [--yes] [--dry-run] [--dir DIR] [--address ADRES] [--ref REF]
#   sudo solargraf status
#   sudo solargraf backup [--to KATALOG]
#   sudo solargraf restore PLIK [--yes]
#   sudo solargraf update [--yes] [--dry-run] [--ref REF]
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
# Nadpisanie tylko do testów (np. szybszy test powrotu po nieudanej aktualizacji w CI).
HEALTH_TIMEOUT_S="${SOLARGRAF_HEALTH_TIMEOUT_S:-300}"
[[ "$HEALTH_TIMEOUT_S" =~ ^[1-9][0-9]*$ ]] || HEALTH_TIMEOUT_S=300
readonly HEALTH_TIMEOUT_S
readonly AGENT_NAME="lokalny"
readonly CORE_SERVICES=(db migrate api worker proxy)
# Źródło kodu w trybie `curl | bash` (D35). Docelowo domena producenta (O13, P7).
readonly GITHUB_REPO="arkadiuszbaglaj/solargraf"
readonly SCRIPT_URL="https://raw.githubusercontent.com/$GITHUB_REPO/main/deploy/install.sh"

DRY_RUN=0
ASSUME_YES=0
PURGE=0
INSTALL_DIR="$DEFAULT_DIR"
ADDRESS=""
SOURCE_REF="main"
REF_GIVEN=0
SRC_DIR=""
SRC_LABEL=""
TMP_DIR=""
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
	# Przy `curl | bash` standardowe wejście to skrypt — pytamy przez terminal.
	# Część wersji sudo (np. sudo-rs w Ubuntu 26.04) nie daje wtedy dostępu do terminala.
	if ! { exec 3</dev/tty; } 2>/dev/null; then
		printf 'BŁĄD: %s — wymagane potwierdzenie, a skrypt nie ma dostępu do terminala.\n' "$question" >&2
		printf 'Pobierz skrypt i uruchom go z pliku (pytania zadziałają):\n' >&2
		printf '  curl -fsSL %s -o install.sh && sudo bash install.sh install\n' "$SCRIPT_URL" >&2
		printf 'albo zgódź się z góry: dodaj --yes na końcu polecenia.\n' >&2
		log_line "BŁĄD: brak terminala do potwierdzenia: $question"
		exit 1
	fi
	read -r -u 3 -p "$question [t/N] " answer
	exec 3<&-
	case "$answer" in
	t | T | tak | TAK | y | Y | yes) return 0 ;;
	*) return 1 ;;
	esac
}

usage() {
	cat <<'EOF'
Użycie:
  install.sh install   [--yes] [--dry-run] [--dir KATALOG] [--address ADRES] [--no-auto-backup] [--no-update-check]
  install.sh backup    [--to KATALOG] [--dir KATALOG]   kopia bazy, sekretów i CA
  install.sh restore PLIK [--yes] [--dir KATALOG]       odtworzenie kopii (zastępuje dane)
  install.sh update    [--yes] [--dry-run] [--ref REF] [--dir KATALOG]   aktualizacja z kopią i powrotem
  install.sh status    [--dir KATALOG]
  install.sh setup-link [--dir KATALOG]   nowy jednorazowy link do pierwszego konta
  install.sh simulator on|off [--dir KATALOG]   symulator urządzenia do testów (SIMULATED)
  install.sh uninstall [--purge] [--yes] [--dir KATALOG]

  --dry-run   pokaż plan i wynik kontroli, nic nie zmieniaj
  --yes       nie pytaj o potwierdzenie (np. instalacja Dockera)
  --dir       katalog instalacji (domyślnie /opt/solargraf)
  --address   adres IPv4 lub nazwa hosta w LAN (domyślnie wykrywany)
  --ref       gałąź lub tag z GitHuba przy instalacji przez curl (domyślnie main);
              przy update — wersja wskazana ręcznie zamiast podpisanego manifestu
  --purge     przy uninstall: usuń także dane (baza, certyfikaty, katalog); kopie zostają
  --to        katalog kopii (domyślnie KATALOG/backups)
  --no-auto-backup / --auto-backup   wyłącz / włącz codzienną kopię o 3:00
  --no-update-check   nowa instalacja bez automatycznego sprawdzania aktualizacji
                      (np. serwer bez Internetu; później zmiana w Ustawieniach)
EOF
}

# --- pomocnicze ------------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# Katalog źródeł obok skryptu albo pusty, gdy skrypt przyszedł przez potok (`curl | bash`).
local_source() {
	local self="${BASH_SOURCE[0]:-}" root
	[ -n "$self" ] && [ -f "$self" ] || return 0
	root="$(dirname "$(dirname "$(readlink -f "$self")")")"
	if [ -f "$root/deploy/compose.yaml" ]; then
		printf '%s' "$root"
	fi
}

cleanup() {
	if [ -n "$TMP_DIR" ]; then
		rm -rf "$TMP_DIR"
	fi
}

source_url() {
	printf '%s' "${SOLARGRAF_SOURCE_URL:-https://codeload.github.com/$GITHUB_REPO/tar.gz/$SOURCE_REF}"
}

# Pobiera kod (tar.gz) z GitHuba — tylko HTTPS (http wyłącznie do testów na localhost).
download_sources() {
	local url
	url="$(source_url)"
	case "$url" in
	https://* | http://127.0.0.1:* | http://localhost:*) ;;
	*) die "Źródło kodu musi używać HTTPS: $url" ;;
	esac
	have curl || die "Brak curl."
	TMP_DIR="$(mktemp -d)"
	trap cleanup EXIT
	say "Pobieram kod: $url"
	curl -fsSL --retry 3 --connect-timeout 15 --max-time 600 -o "$TMP_DIR/src.tar.gz" "$url" ||
		die "Nie udało się pobrać kodu z $url."
	mkdir "$TMP_DIR/src"
	tar -xzf "$TMP_DIR/src.tar.gz" -C "$TMP_DIR/src" --strip-components=1 --no-same-owner
	[ -f "$TMP_DIR/src/deploy/compose.yaml" ] || die "Pobrane archiwum nie zawiera deploy/compose.yaml."
	if [ ! -f "$TMP_DIR/src/VERSION" ]; then
		printf 'github:%s\n' "$SOURCE_REF" >"$TMP_DIR/src/VERSION"
	fi
	SRC_DIR="$TMP_DIR/src"
}

resolve_sources() {
	SRC_DIR="$(local_source)"
	if [ -n "$SRC_DIR" ]; then
		SRC_LABEL="$SRC_DIR"
	else
		SRC_LABEL="$(source_url)"
	fi
}

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

simulator_enabled() {
	[ -f "$INSTALL_DIR/.env" ] && grep -q '^SOLARGRAF_SIMULATOR=1$' "$INSTALL_DIR/.env"
}

compose() {
	local profiles=()
	if simulator_enabled; then
		profiles=(--profile symulator)
	fi
	docker compose -p "$PRODUCT" \
		-f "$INSTALL_DIR/src/deploy/compose.yaml" \
		--env-file "$INSTALL_DIR/.env" "${profiles[@]}" "$@"
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
	debian:12 | debian:13 | ubuntu:24.04 | ubuntu:26.04 | raspbian:12 | raspbian:13)
		say "System: ${PRETTY_NAME:-$OS_ID $OS_VERSION} — wspierany." ;;
	debian:* | ubuntu:* | raspbian:*)
		warn "System ${PRETTY_NAME:-$OS_ID $OS_VERSION} nie jest na liście wspieranych (Debian 12/13, Ubuntu 24.04/26.04, Raspberry Pi OS 64-bit)." ;;
	*)
		die "Nieobsługiwany system: ${PRETTY_NAME:-$OS_ID}. Wspierane: Debian 12/13, Ubuntu 24.04/26.04, Raspberry Pi OS 64-bit." ;;
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
	check_clock
}

# Synchronizacja czasu (D53): zły zegar serwera psuje znaczniki czasu pomiarów i statusy.
# Tylko ostrzeżenie — nie blokuje instalacji. Przy chrony liczy się jego stan, nie flaga timedatectl.
CLOCK_MAX_OFFSET_S=1

check_clock() {
	local leap offset synced
	if have chronyc && leap="$(chronyc tracking 2>/dev/null | awk -F': *' '/^Leap status/ {print $2}')" && [ -n "$leap" ]; then
		offset="$(chronyc tracking 2>/dev/null | awk -F': *' '/^System time/ {split($2, a, " "); print a[1]}')"
		if [ "$leap" != "Normal" ]; then
			warn "Zegar: chrony nie jest zsynchronizowany ($leap). Sprawdź: chronyc sources (dostęp do NTP, UDP 123)."
		elif [ -n "$offset" ] && awk -v o="$offset" -v m="$CLOCK_MAX_OFFSET_S" 'BEGIN {exit !(o > m)}'; then
			warn "Zegar: różni się od NTP o ${offset%.*} s. Popraw: sudo chronyc makestep"
		else
			say "Zegar: zsynchronizowany (chrony)."
		fi
		return 0
	fi
	synced="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
	case "$synced" in
	yes) say "Zegar: zsynchronizowany (NTP)." ;;
	no) warn "Zegar: brak synchronizacji NTP. Sprawdź: timedatectl (włącz: sudo timedatectl set-ntp true)." ;;
	*) warn "Zegar: nie udało się sprawdzić synchronizacji czasu (brak chrony i timedatectl)." ;;
	esac
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
	if [ -z "$SRC_DIR" ]; then
		download_sources
	fi
	local src="$SRC_DIR"
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

# Ustawia KLUCZ=wartość w .env (600). Wpis trafia przed adresy, które write_env zawsze
# dopisuje na końcu — dzięki temu ponowna instalacja nie zmienia układu pliku.
env_set() {
	local env="$INSTALL_DIR/.env" key="$1" value="$2"
	(
		umask 077
		grep -v -e "^$key=" -e '^SOLARGRAF_SITE_ADDRESSES=' -e '^SOLARGRAF_PUBLIC_ADDRESS=' \
			"$env" >"$env.tmp" || true
		printf '%s=%s\n' "$key" "$value" >>"$env.tmp"
		grep -e '^SOLARGRAF_SITE_ADDRESSES=' -e '^SOLARGRAF_PUBLIC_ADDRESS=' "$env" >>"$env.tmp" || true
	)
	mv "$env.tmp" "$env"
	chmod 600 "$env"
}

env_unset() {
	local env="$INSTALL_DIR/.env" key="$1"
	(
		umask 077
		grep -v "^$key=" "$env" >"$env.tmp" || true
	)
	mv "$env.tmp" "$env"
	chmod 600 "$env"
}

# Token agenta (D43): tworzony raz i zapisany tylko w .env (600) — nigdy na ekranie ani w logu.
# Gdy .env go nie ma, a agent już istnieje (np. odtworzony .env), wydajemy nowy token (rotate).
ensure_agent_token() {
	local env="$INSTALL_DIR/.env" token
	if grep -q '^SOLARGRAF_AGENT_TOKEN=.' "$env"; then
		say "Token agenta: zachowany w $env."
		return 0
	fi
	if ! token="$(compose exec -T api solargraf-admin agent create --name "$AGENT_NAME" 2>/dev/null)"; then
		token="$(compose exec -T api solargraf-admin agent rotate --name "$AGENT_NAME" 2>/dev/null)" ||
			die "Nie udało się utworzyć tokenu agenta. Logi: docker compose -p $PRODUCT logs api"
		say "Agent $AGENT_NAME istniał — wydano nowy token (poprzedni przestał działać)."
	fi
	[[ "$token" =~ ^[A-Za-z0-9_-]+$ ]] || die "Nieoczekiwana odpowiedź przy tworzeniu tokenu agenta."
	env_set SOLARGRAF_AGENT_TOKEN "$token"
	log_line "zapisano token agenta $AGENT_NAME w .env (treść pominięta)"
	say "Token agenta $AGENT_NAME zapisany w $env."
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
	say "- źródła z $SRC_LABEL → $INSTALL_DIR/src"
	say "- sekrety w $INSTALL_DIR/.env (600), adresy: $(site_addresses)"
	say "- budowa obrazów i start: db, migrate, api, proxy (porty 80 i 443), agent"
	say "- lokalny agent \"$AGENT_NAME\" z tokenem w $INSTALL_DIR/.env"
	say "- polecenie $CLI_LINK"
	say "- jednorazowy link do pierwszego konta"
	say "- codzienna kopia zapasowa o 3:00 w $INSTALL_DIR/backups (o ile nie wyłączono)"
	say "- usługa aktualizacji zlecanej w aplikacji (systemd, $INSTALL_DIR/run)"
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
	resolve_sources
	check_system
	ensure_docker
	show_plan "$existing"
	if [ "$DRY_RUN" -eq 1 ]; then
		say "== Tryb --dry-run: nic nie zmieniono (ostrzeżenia: $WARNINGS)."
		return 0
	fi

	copy_sources
	write_env
	apply_update_check
	ensure_run_dirs
	say "== Budowa obrazów i uruchomienie (pierwsza budowa może potrwać kilka–kilkanaście minut)"
	compose up -d --build --remove-orphans "${CORE_SERVICES[@]}"
	wait_healthy
	ensure_agent_token
	say "== Uruchamiam agenta"
	compose up -d --build agent
	if simulator_enabled; then
		say "== Symulator (SIMULATED) włączony — uruchamiam"
		compose up -d --build simulator
	fi
	export_ca
	ln -sf "$INSTALL_DIR/src/deploy/install.sh" "$CLI_LINK"
	install_backup_timer
	install_update_units
	say "Polecenie: $CLI_LINK (status, update, backup, restore, uninstall, setup-link, simulator on|off)."

	say ""
	say "Gotowe. Adres aplikacji: https://${ADDRESS:-localhost}/"
	print_setup_link
	if [ "$WARNINGS" -gt 0 ]; then
		say "Ostrzeżenia: $WARNINGS (powyżej)."
	fi
}

# --- status, link, odinstalowanie ------------------------------------------------------------

require_installation() {
	if [ ! -f "$INSTALL_DIR/.env" ] || [ ! -f "$INSTALL_DIR/src/deploy/compose.yaml" ]; then
		die "Brak instalacji w $INSTALL_DIR."
	fi
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
	check_clock
	if simulator_enabled; then
		say "Symulator (SIMULATED): włączony (wyłącz: sudo $CLI_LINK simulator off)"
	else
		say "Symulator (SIMULATED): wyłączony"
	fi
	local last
	# Katalog kopii może jeszcze nie istnieć — to nie błąd.
	last="$(find "$(backup_dir)" -maxdepth 1 -type f -name "$PRODUCT-backup-*.tar.gz" 2>/dev/null | sort | tail -n1 || true)"
	say "Ostatnia kopia: ${last:-brak}"
	if have systemctl && systemctl is-enabled --quiet "$TIMER_UNIT.timer" 2>/dev/null; then
		say "Kopia automatyczna: włączona (codziennie o 3:00)"
	else
		say "Kopia automatyczna: wyłączona"
	fi
	df -h "$INSTALL_DIR" /var/lib
}

# --- symulator (D45) -------------------------------------------------------------------------

SIM_ACTION=""

cmd_simulator() {
	require_root
	require_installation
	LOG_FILE="$INSTALL_DIR/install.log"
	case "$SIM_ACTION" in
	on)
		log_line "--- simulator on"
		env_set SOLARGRAF_SIMULATOR 1
		say "Buduję i uruchamiam symulator (dane SIMULATED, tylko w sieci Docker, bez portu na hoście)."
		compose up -d --build simulator
		say ""
		say "Symulator działa. Dodaj urządzenie w aplikacji: Instalacje → Urządzenia →"
		say "  profil: [SIMULATED] …, adres: simulator, port: 5020, unit ID: 1"
		say "Odczyty pojawią się po pierwszym cyklu agenta (do ok. 1 min)."
		say "Wyłączenie: sudo $CLI_LINK simulator off"
		;;
	off)
		log_line "--- simulator off"
		if simulator_enabled; then
			compose rm --stop --force simulator
		fi
		env_unset SOLARGRAF_SIMULATOR
		say "Symulator wyłączony. Zapisane odczyty zostają w bazie, oznaczone jako SIMULATED."
		say "Urządzenie symulatora wyłącz lub usuń w aplikacji (Instalacje → Urządzenia)."
		;;
	*) die "Użycie: $CLI_LINK simulator on|off" ;;
	esac
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
		for image in $APP_IMAGES; do
			docker image rm -f "$image:local" "$image:previous" >/dev/null 2>&1 || true
		done
		remove_backup_timer
		remove_update_units
		rm -f "$CLI_LINK"
		LOG_FILE=""
		# Kopii zapasowych nie usuwamy (D17, D62).
		find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name backups -exec rm -rf {} +
		if [ -z "$(ls -A "$INSTALL_DIR/backups" 2>/dev/null)" ]; then
			rm -rf "$INSTALL_DIR"
			say "Usunięto aplikację i dane."
		else
			say "Usunięto aplikację i dane. Kopie zapasowe zostały w $INSTALL_DIR/backups."
		fi
	else
		confirm "Zatrzymać i usunąć kontenery aplikacji? Dane i sekrety zostaną zachowane." || die "Przerwano."
		compose down --remove-orphans
		remove_backup_timer
		remove_update_units
		rm -f "$CLI_LINK"
		say "Usunięto kontenery. Dane (wolumeny) i $INSTALL_DIR zostały zachowane."
		say "Ponowna instalacja: sudo $INSTALL_DIR/src/deploy/install.sh install"
	fi
}

# --- kopia zapasowa i odtworzenie (D62) ------------------------------------------------------

readonly BACKUP_KEEP_AUTO=7
readonly BACKUP_FORMAT=1
readonly BACKUP_MEMBERS="db.dump env caddy-pki.tar manifest.txt SHA256SUMS"
readonly TIMER_UNIT="$PRODUCT-backup"
readonly SYSTEMD_DIR="/etc/systemd/system"

BACKUP_TO=""
BACKUP_KIND="manual"
RESTORE_FILE=""
AUTO_BACKUP=""
UPDATE_CHECK=""

backup_dir() { printf '%s' "${BACKUP_TO:-$INSTALL_DIR/backups}"; }

db_sql() { compose exec -T db psql -U "$PRODUCT" -d "$PRODUCT" -tAc "$1"; }

# Gotowość przez TCP: tymczasowy serwer inicjalizacji obrazu postgres słucha tylko na gnieździe.
wait_db() {
	local waited=0
	until compose exec -T db pg_isready -q -h 127.0.0.1 -U "$PRODUCT" -d "$PRODUCT" >/dev/null 2>&1; do
		[ "$waited" -lt 120 ] || die "Baza danych nie zgłosiła gotowości. Logi: docker compose -p $PRODUCT logs db"
		sleep 2
		waited=$((waited + 2))
	done
}

db_running() { [ -n "$(compose ps -q --status running db 2>/dev/null || true)" ]; }

# Tworzy archiwum kopii i wypisuje jego ścieżkę na stdout (komunikaty na stderr).
make_backup() {
	local kind="$1" dir stamp name work revision version pki=1
	dir="$(backup_dir)"
	db_running || die "Baza danych nie działa — kopia niemożliwa. Uruchom aplikację: sudo $CLI_LINK install"
	(umask 077 && mkdir -p "$dir")
	chmod 700 "$dir"
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	name="$PRODUCT-backup-$stamp-$kind.tar.gz"
	work="$(mktemp -d)"
	chmod 700 "$work"
	revision="$(db_sql 'SELECT version_num FROM alembic_version' 2>/dev/null | tr -d '[:space:]' || true)"
	version="$(cat "$INSTALL_DIR/src/VERSION" 2>/dev/null || echo nieznana)"
	if ! compose exec -T db pg_dump -U "$PRODUCT" -d "$PRODUCT" -Fc >"$work/db.dump"; then
		rm -rf "$work"
		die "Zrzut bazy (pg_dump) nie powiódł się."
	fi
	cp "$INSTALL_DIR/.env" "$work/env"
	if ! compose exec -T proxy tar -C /data/caddy -cf - pki >"$work/caddy-pki.tar" 2>/dev/null; then
		: >"$work/caddy-pki.tar"
		pki=0
		warn "Nie udało się skopiować CA proxy — po odtworzeniu przeglądarki będą wymagały nowego certyfikatu."
	fi
	{
		printf 'format=%s\n' "$BACKUP_FORMAT"
		printf 'product=%s\n' "$PRODUCT"
		printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf 'kind=%s\n' "$kind"
		printf 'app_version=%s\n' "$version"
		printf 'db_revision=%s\n' "$revision"
		printf 'caddy_pki=%s\n' "$pki"
	} >"$work/manifest.txt"
	(cd "$work" && sha256sum db.dump env caddy-pki.tar manifest.txt >SHA256SUMS)
	(umask 077 && tar -C "$work" -czf "$dir/$name.part" db.dump env caddy-pki.tar manifest.txt SHA256SUMS)
	rm -rf "$work"
	chmod 600 "$dir/$name.part"
	mv "$dir/$name.part" "$dir/$name"
	log_line "utworzono kopię $dir/$name (rodzaj: $kind, rewizja: ${revision:-brak})"
	printf '%s\n' "$dir/$name"
}

# Zostawia BACKUP_KEEP_AUTO najnowszych kopii automatycznych; ręcznych nie dotyka.
prune_auto_backups() {
	local dir old
	dir="$(backup_dir)"
	while IFS= read -r old; do
		[ -n "$old" ] || continue
		rm -f -- "$old"
		log_line "usunięto starą kopię automatyczną $old"
		printf 'Usunięto starą kopię automatyczną: %s\n' "$old" >&2
	done < <(find "$dir" -maxdepth 1 -type f -name "$PRODUCT-backup-*-auto.tar.gz" | sort -r | tail -n +"$((BACKUP_KEEP_AUTO + 1))")
}

cmd_backup() {
	require_root
	require_installation
	LOG_FILE="$INSTALL_DIR/install.log"
	log_line "--- backup ($BACKUP_KIND)"
	local file
	file="$(make_backup "$BACKUP_KIND")"
	say "Kopia zapasowa: $file"
	if [ "$BACKUP_KIND" = "auto" ]; then
		prune_auto_backups
	fi
	say "Kopia zawiera sekrety (.env). Przechowuj ją bezpiecznie i skopiuj na inny nośnik."
}

# Sprawdza archiwum przed jakąkolwiek zmianą: lista plików, sumy, format, rewizja migracji.
verify_backup() {
	local file="$1" work="$2" member revision known
	[ -f "$file" ] || die "Brak pliku kopii: $file"
	tar -tzf "$file" >/dev/null 2>&1 || die "Plik nie jest archiwum kopii: $file"
	while IFS= read -r member; do
		member="${member#./}"
		case " $BACKUP_MEMBERS " in
		*" $member "*) ;;
		*) die "Nieoczekiwany plik w archiwum kopii: $member" ;;
		esac
	done < <(tar -tzf "$file")
	tar -xzf "$file" -C "$work" --no-same-owner --no-same-permissions
	for member in $BACKUP_MEMBERS; do
		[ -f "$work/$member" ] || die "Niepełna kopia — brak $member."
	done
	(cd "$work" && sha256sum --quiet -c SHA256SUMS >/dev/null 2>&1) || die "Sumy kontrolne kopii się nie zgadzają — plik jest uszkodzony."
	grep -qx "format=$BACKUP_FORMAT" "$work/manifest.txt" || die "Nieobsługiwany format kopii."
	grep -qx "product=$PRODUCT" "$work/manifest.txt" || die "To nie jest kopia $PRODUCT."
	revision="$(sed -n 's/^db_revision=//p' "$work/manifest.txt")"
	[[ "$revision" =~ ^[A-Za-z0-9_]+$ ]] || die "Kopia nie zawiera rewizji migracji bazy."
	known="$(sed -n 's/^revision: str = "\(.*\)"$/\1/p' "$INSTALL_DIR"/src/server/alembic/versions/*.py)"
	if ! printf '%s\n' "$known" | grep -qx "$revision"; then
		die "Kopia pochodzi z nowszej wersji aplikacji (rewizja bazy $revision). Najpierw zaktualizuj aplikację."
	fi
}

cmd_restore() {
	require_root
	require_installation
	LOG_FILE="$INSTALL_DIR/install.log"
	[ -n "$RESTORE_FILE" ] || die "Użycie: $CLI_LINK restore PLIK [--yes]"
	RESTORE_FILE="$(readlink -f "$RESTORE_FILE")"
	log_line "--- restore $RESTORE_FILE"
	TMP_DIR="$(mktemp -d)"
	chmod 700 "$TMP_DIR"
	trap cleanup EXIT
	verify_backup "$RESTORE_FILE" "$TMP_DIR"
	say "Kopia: $(sed -n 's/^created_at=//p' "$TMP_DIR/manifest.txt"), wersja $(sed -n 's/^app_version=//p' "$TMP_DIR/manifest.txt")."
	confirm "Odtworzyć kopię? Bieżąca baza, sekrety i CA zostaną zastąpione (najpierw powstanie kopia bieżącego stanu)." ||
		die "Przerwano."

	say "== Kopia bieżącego stanu"
	compose up -d db
	wait_db
	local safety
	safety="$(make_backup pre-restore)"
	say "Zapisano: $safety"

	say "== Odtwarzanie bazy"
	compose down --remove-orphans
	docker volume rm "${PRODUCT}_db-data" >/dev/null
	(umask 077 && cp "$TMP_DIR/env" "$INSTALL_DIR/.env")
	chmod 600 "$INSTALL_DIR/.env"
	if [ -z "$ADDRESS" ]; then
		ADDRESS="$(detect_address)"
	fi
	# Adresy z kopii mogą dotyczyć innego hosta — odświeżamy je jak przy instalacji.
	write_env
	ensure_run_dirs
	compose up -d db
	wait_db
	compose exec -T db pg_restore -U "$PRODUCT" -d "$PRODUCT" --no-owner --exit-on-error --single-transaction \
		<"$TMP_DIR/db.dump" || die "Odtworzenie bazy nie powiodło się. Kopia sprzed odtworzenia jest w $(backup_dir)."

	say "== Migracje i uruchomienie"
	compose up -d --remove-orphans "${CORE_SERVICES[@]}"
	wait_healthy
	if grep -qx 'caddy_pki=1' "$TMP_DIR/manifest.txt"; then
		# Certyfikaty serwera wystawione przez poprzednie CA są usuwane — Caddy wystawi nowe.
		compose exec -T proxy sh -c 'rm -rf /data/caddy/pki /data/caddy/certificates/local && tar -C /data/caddy -xf -' \
			<"$TMP_DIR/caddy-pki.tar"
		compose restart proxy
		wait_healthy
		export_ca
	fi
	compose up -d agent
	if simulator_enabled; then
		compose up -d simulator
	fi
	say "Odtworzono kopię $RESTORE_FILE."
}

# Wartość początkowa automatycznego sprawdzania aktualizacji (D63); dalej decyduje ustawienie w UI.
apply_update_check() {
	if [ "$UPDATE_CHECK" = "0" ]; then
		env_set SOLARGRAF_UPDATE_CHECK false
		say "Automatyczne sprawdzanie aktualizacji: wyłączone na start (zmiana w Ustawieniach)."
	elif [ "$UPDATE_CHECK" = "1" ]; then
		env_unset SOLARGRAF_UPDATE_CHECK
	fi
}

# Kopia automatyczna codziennie o 3:00 (D62). Wyłączenie zapamiętane w .env.
auto_backup_enabled() { ! grep -q '^SOLARGRAF_AUTO_BACKUP=0$' "$INSTALL_DIR/.env"; }

install_backup_timer() {
	if [ "$AUTO_BACKUP" = "0" ]; then
		env_set SOLARGRAF_AUTO_BACKUP 0
	elif [ "$AUTO_BACKUP" = "1" ]; then
		env_unset SOLARGRAF_AUTO_BACKUP
	fi
	if ! have systemctl || [ ! -d /run/systemd/system ]; then
		warn "Brak systemd — kopia automatyczna niedostępna. Rób kopie ręcznie: sudo $CLI_LINK backup"
		return 0
	fi
	if ! auto_backup_enabled; then
		remove_backup_timer
		say "Kopia automatyczna: wyłączona (włączenie: install --auto-backup)."
		return 0
	fi
	cat >"$SYSTEMD_DIR/$TIMER_UNIT.service" <<EOF
[Unit]
Description=$PRODUCT (nazwa robocza) — automatyczna kopia zapasowa
After=docker.service

[Service]
Type=oneshot
ExecStart="$INSTALL_DIR/src/deploy/install.sh" backup --auto --dir "$INSTALL_DIR"
EOF
	cat >"$SYSTEMD_DIR/$TIMER_UNIT.timer" <<EOF
[Unit]
Description=$PRODUCT (nazwa robocza) — codzienna kopia zapasowa o 3:00

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
	systemctl daemon-reload
	systemctl enable --now "$TIMER_UNIT.timer" >/dev/null 2>&1
	say "Kopia automatyczna: codziennie o 3:00 w $INSTALL_DIR/backups (7 ostatnich)."
}

remove_backup_timer() {
	if have systemctl && [ -f "$SYSTEMD_DIR/$TIMER_UNIT.timer" ]; then
		systemctl disable --now "$TIMER_UNIT.timer" >/dev/null 2>&1 || true
		rm -f "$SYSTEMD_DIR/$TIMER_UNIT.timer" "$SYSTEMD_DIR/$TIMER_UNIT.service"
		systemctl daemon-reload
	fi
}

# --- aktualizacja (D17, D65) -----------------------------------------------------------------
#
# Kolejność: wersja docelowa (podpisany manifest albo --ref) → kopia pre-update → zachowanie
# poprzedniego kodu (src.previous) i obrazów (:previous) → nowy kod, budowa, migracje, start,
# gotowość. Błąd po przełączeniu kodu uruchamia powrót (pułapka EXIT): poprzedni kod i obrazy,
# a gdy migracje zmieniły bazę — odtworzenie kopii pre-update. Po sukcesie sprzątanie (D17).

readonly APP_IMAGES="solargraf-api solargraf-proxy solargraf-agent solargraf-simulator"
# Kody wyjścia `solargraf-admin update-target` (server/src/solargraf_server/cli.py).
readonly TARGET_NO_NEWER=10
readonly TARGET_INTERMEDIATE=11

UPDATE_PHASE=""
UPDATE_BACKUP=""
UPDATE_FROM=""
UPDATE_TO=""
DB_REVISION_BEFORE=""
OLD_PREVIOUS_IMAGES=""

# Numer wersji aplikacji z kodu (jedno źródło, tools/release.py) albo pusty.
app_version() {
	sed -n 's/^__version__ = "\([0-9][0-9.]*\)"$/\1/p' "$1/server/src/solargraf_server/__init__.py" 2>/dev/null | head -n1
}

# Sukces, gdy wersja $1 jest starsza niż $2 (obie MAJOR.MINOR.PATCH).
version_lt() {
	[ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)" = "$1" ]
}

db_revision() { db_sql 'SELECT version_num FROM alembic_version' 2>/dev/null | tr -d '[:space:]' || true; }

# Wersja docelowa z manifestu sprawdzonego kluczem wbudowanym w zainstalowaną wersję
# (ustawia UPDATE_TARGET). Kończy skrypt kodem 0, gdy nie ma nowszej wersji.
UPDATE_TARGET=""

manifest_target() {
	local code=0
	UPDATE_TARGET="$(compose exec -T api solargraf-admin update-target)" || code=$?
	case "$code" in
	0) ;;
	"$TARGET_NO_NEWER")
		say "Brak nowszej wersji — aktualizacja nie jest potrzebna."
		UPDATE_PHASE="no-update"
		exit 0
		;;
	"$TARGET_INTERMEDIATE") die "Najnowsza wersja wymaga aktualizacji pośredniej — szczegóły powyżej." ;;
	*) die "Nie udało się sprawdzić podpisanego manifestu wersji (szczegóły powyżej)." ;;
	esac
	[[ "$UPDATE_TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Nieoczekiwana odpowiedź przy sprawdzaniu wersji."
}

# --- stan aktualizacji dla UI (D65) ---
#
# Plik JSON w katalogu należącym do roota (API montuje go tylko do odczytu). Pola tylko
# z zamkniętych zbiorów i numery wersji po walidacji — bez ścieżek, komunikatów i sekretów.
UPDATE_STARTED_AT=""
UPDATE_STEP="CHECK"
FROM_REQUEST=0
# Przyczyna błędu dla UI — tylko z zamkniętego zbioru (LOW_DISK) i liczby po walidacji.
UPDATE_REASON=""
UPDATE_FREE_MB=""
# MB odzyskane przy sprzątaniu po udanej aktualizacji (raport w pliku stanu i w UI).
UPDATE_RECLAIMED_MB=""

json_version() {
	if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then printf '"%s"' "$1"; else printf 'null'; fi
}

json_reason() {
	if [ "$UPDATE_REASON" = "LOW_DISK" ] && [[ "$UPDATE_FREE_MB" =~ ^[0-9]+$ ]]; then
		printf '"reason":"LOW_DISK","free_mb":%s,"required_mb":%s' "$UPDATE_FREE_MB" "$MIN_DISK_MB"
	else
		printf '"reason":null,"free_mb":null,"required_mb":null'
	fi
	if [[ "$UPDATE_RECLAIMED_MB" =~ ^[0-9]+$ ]]; then
		printf ',"reclaimed_mb":%s' "$UPDATE_RECLAIMED_MB"
	else
		printf ',"reclaimed_mb":null'
	fi
}

write_update_status() {
	local state="$1" step="$2" dir="$INSTALL_DIR/run/update-status" finished="null"
	[ "$state" != "RUNNING" ] || UPDATE_STEP="$step"
	[ "$DRY_RUN" -eq 0 ] && [ -n "$UPDATE_STARTED_AT" ] && [ -d "$dir" ] || return 0
	[ "$state" = "RUNNING" ] || finished="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
	(
		umask 022
		printf '{"state":"%s","step":"%s","from_version":%s,"to_version":%s,"started_at":"%s","finished_at":%s,%s}\n' \
			"$state" "$step" "$(json_version "$UPDATE_FROM")" "$(json_version "$UPDATE_TO")" \
			"$UPDATE_STARTED_AT" "$finished" "$(json_reason)" >"$dir/status.json.tmp"
	)
	mv -f "$dir/status.json.tmp" "$dir/status.json"
}

update_trap() {
	local status=$?
	trap - EXIT
	set +e
	case "$UPDATE_PHASE" in
	switched)
		write_update_status RUNNING ROLLBACK
		if rollback_update; then
			write_update_status ROLLED_BACK DONE
		else
			write_update_status FAILED ROLLBACK
		fi
		status=1
		;;
	no-update) write_update_status NO_UPDATE DONE ;;
	done) ;;
	*) [ "$status" -eq 0 ] || write_update_status FAILED "$UPDATE_STEP" ;;
	esac
	cleanup
	exit "$status"
}

# Wraca do poprzedniej wersji; kod 0 tylko, gdy aplikacja po powrocie zgłasza gotowość.
rollback_update() {
	local revision image
	say ""
	say "== Aktualizacja nie powiodła się — przywracam wersję $UPDATE_FROM"
	revision="$(db_revision)"
	compose down --remove-orphans >/dev/null 2>&1
	rm -rf "$INSTALL_DIR/src"
	mv "$INSTALL_DIR/src.previous" "$INSTALL_DIR/src"
	post_switch_hook || true
	for image in $APP_IMAGES; do
		if docker image inspect "$image:previous" >/dev/null 2>&1; then
			docker image tag "$image:previous" "$image:local"
		fi
	done
	if [ "$revision" != "$DB_REVISION_BEFORE" ]; then
		say "Migracje zmieniły bazę ($DB_REVISION_BEFORE → ${revision:-nieznana}) — odtwarzam kopię $UPDATE_BACKUP."
		if ! "$INSTALL_DIR/src/deploy/install.sh" restore "$UPDATE_BACKUP" --yes --dir "$INSTALL_DIR"; then
			printf 'BŁĄD: Nie udało się odtworzyć kopii. Zrób to ręcznie: sudo %s restore %s\n' "$CLI_LINK" "$UPDATE_BACKUP" >&2
			log_line "BŁĄD: powrót — odtworzenie kopii nie powiodło się"
			return 1
		fi
	else
		compose up -d --remove-orphans "${CORE_SERVICES[@]}"
		compose up -d agent
		if simulator_enabled; then
			compose up -d simulator
		fi
	fi
	if curl -fsk --max-time 5 --retry 24 --retry-delay 5 --retry-all-errors -o /dev/null https://localhost/api/health/ready 2>/dev/null; then
		say "Przywrócono wersję $UPDATE_FROM — aplikacja działa. Kopia sprzed aktualizacji: $UPDATE_BACKUP"
	else
		printf 'BŁĄD: Po przywróceniu wersji %s aplikacja nie zgłasza gotowości. Logi: docker compose -p %s logs\n' "$UPDATE_FROM" "$PRODUCT" >&2
		log_line "BŁĄD: powrót — brak gotowości"
		return 1
	fi
}

# Kod wersji, która właśnie trafiła do src, przygotowuje swoje katalogi i jednostki systemd
# (np. nowe montowania w compose.yaml). Starsze wersje bez tego polecenia — pomijamy.
post_switch_hook() {
	local script="$INSTALL_DIR/src/deploy/install.sh"
	if grep -q '^	post-switch) cmd_post_switch ;;$' "$script"; then
		"$script" post-switch --dir "$INSTALL_DIR"
	fi
}

cmd_post_switch() {
	require_root
	require_installation
	LOG_FILE="$INSTALL_DIR/install.log"
	ensure_run_dirs
	install_update_units
}

# --- instalacja aktualizacji z UI: katalogi i usługa systemd (D65) ---

readonly UPDATE_UNIT="$PRODUCT-update"
# Użytkownik kontenera API (server/Dockerfile) — tylko on może zapisać flagę.
readonly API_UID=10001

# run/update-request — 0700, właściciel: użytkownik API (flaga); run/update-status — root, 0755
# (stan, API tylko czyta). Root nigdy nie pisze do katalogu kontrolowanego przez API.
ensure_run_dirs() {
	local run="$INSTALL_DIR/run"
	install -d -m 0755 -o root -g root "$run" "$run/update-status"
	install -d -m 0700 -o "$API_UID" -g "$API_UID" "$run/update-request"
	if ! grep -qx "SOLARGRAF_RUN_DIR=$run" "$INSTALL_DIR/.env"; then
		env_set SOLARGRAF_RUN_DIR "$run"
	fi
}

install_update_units() {
	if ! have systemctl || [ ! -d /run/systemd/system ]; then
		warn "Brak systemd — instalacja aktualizacji z aplikacji niedostępna. Aktualizuj poleceniem: sudo $CLI_LINK update"
		return 0
	fi
	cat >"$SYSTEMD_DIR/$UPDATE_UNIT.service" <<EOF
[Unit]
Description=$PRODUCT (nazwa robocza) — aktualizacja zlecona w aplikacji
After=docker.service

[Service]
Type=oneshot
TimeoutStartSec=3h
ExecStart="$INSTALL_DIR/src/deploy/install.sh" update --from-request --dir "$INSTALL_DIR"
EOF
	cat >"$SYSTEMD_DIR/$UPDATE_UNIT.path" <<EOF
[Unit]
Description=$PRODUCT (nazwa robocza) — oczekiwanie na zlecenie aktualizacji z aplikacji

[Path]
PathExists=$INSTALL_DIR/run/update-request/update
Unit=$UPDATE_UNIT.service

[Install]
WantedBy=paths.target
EOF
	systemctl daemon-reload
	systemctl enable --now "$UPDATE_UNIT.path" >/dev/null 2>&1
	say "Aktualizacja z aplikacji: włączona (Ustawienia → Aktualizacje, tylko właściciel)."
}

remove_update_units() {
	if have systemctl && [ -f "$SYSTEMD_DIR/$UPDATE_UNIT.path" ]; then
		systemctl disable --now "$UPDATE_UNIT.path" >/dev/null 2>&1 || true
		rm -f "$SYSTEMD_DIR/$UPDATE_UNIT.path" "$SYSTEMD_DIR/$UPDATE_UNIT.service"
		systemctl daemon-reload
	fi
}

# Sprzątanie po udanej aktualizacji (D17, D73): obrazy aplikacji starsze niż poprzednia wersja,
# osierocone obrazy <none> z etykietą produktu i stary cache budowania; na końcu raport
# odzyskanego miejsca. Nigdy wolumeny, kopie, konfiguracja ani obrazy innych aplikacji.
readonly PRODUCT_LABEL="com.solargraf.product=$PRODUCT"

cleanup_after_update() {
	local id before after
	before="$(update_free_mb)"
	for id in $OLD_PREVIOUS_IMAGES; do
		# Bez -f: obraz nadal oznaczony inną nazwą albo używany przez kontener zostaje.
		docker image rm "$id" >/dev/null 2>&1 || true
	done
	# Bez --all: tylko obrazy bez nazwy (<none>), i tylko z etykietą produktu.
	docker image prune -f --filter "label=$PRODUCT_LABEL" >/dev/null 2>&1 || true
	docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
	after="$(update_free_mb)"
	UPDATE_RECLAIMED_MB="$(reclaimed_mb "$before" "$after")"
	say "Sprzątanie: usunięto starsze i osierocone obrazy aplikacji oraz cache budowania starszy niż 7 dni (poprzednia wersja zostaje)."
	say "Sprzątanie: odzyskano $UPDATE_RECLAIMED_MB MB (wolne w /var/lib: $before → $after MB)."
	log_line "sprzątanie: wolne $before → $after MB"
}

# Odzyskane miejsce w MB; nigdy ujemne (w tym czasie inne procesy mogą zapisywać na dysk).
reclaimed_mb() {
	local diff=$(($2 - $1))
	if [ "$diff" -lt 0 ]; then
		diff=0
	fi
	printf '%s' "$diff"
}

# Miejsce na kopię, nowe obrazy i budowanie. Przy braku najpierw usuwa cache budowania Dockera
# (bezpieczne — odtwarza się przy budowaniu) i sprawdza ponownie; nadal za mało — błąd LOW_DISK.
update_free_mb() { df -Pm /var/lib | awk 'NR==2 {print $4}'; }

ensure_update_disk() {
	local free_mb
	free_mb="$(update_free_mb)"
	if [ "$free_mb" -lt "$MIN_DISK_MB" ]; then
		say "Wolne miejsce w /var/lib: ${free_mb} MB (minimum ${MIN_DISK_MB} MB) — usuwam cache budowania Dockera."
		docker builder prune -af >/dev/null 2>&1 || true
		free_mb="$(update_free_mb)"
	fi
	if [ "$free_mb" -lt "$MIN_DISK_MB" ]; then
		UPDATE_REASON="LOW_DISK"
		UPDATE_FREE_MB="$free_mb"
		die "Za mało miejsca w /var/lib: ${free_mb} MB (minimum ${MIN_DISK_MB} MB). Zwolnij miejsce (np. stare kopie w $(backup_dir), nieużywane obrazy — docker system df) i spróbuj ponownie."
	fi
	say "Wolne miejsce w /var/lib: ${free_mb} MB."
}

cmd_update() {
	if [ "$DRY_RUN" -eq 0 ]; then
		require_root
	fi
	require_installation
	if [ "$FROM_REQUEST" -eq 1 ]; then
		# Zlecenie z aplikacji (usługa systemd): flaga tylko uruchamia, jej treść jest ignorowana;
		# wersja wyłącznie z podpisanego manifestu, bez --ref i bez paczki.
		rm -f "$INSTALL_DIR/run/update-request/update"
		if [ "$REF_GIVEN" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
			die "--from-request nie łączy się z --ref ani --dry-run."
		fi
		ASSUME_YES=1
	fi
	if [ "$DRY_RUN" -eq 0 ]; then
		LOG_FILE="$INSTALL_DIR/install.log"
		exec 9>"$INSTALL_DIR/update.lock"
		flock -n 9 || die "Aktualizacja już trwa."
	fi
	log_line "--- update (z aplikacji: $FROM_REQUEST)"
	UPDATE_FROM="$(app_version "$INSTALL_DIR/src")"
	[ -n "$UPDATE_FROM" ] || UPDATE_FROM="nieznana"
	if [ "$DRY_RUN" -eq 0 ]; then
		UPDATE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		trap update_trap EXIT
		write_update_status RUNNING CHECK
	fi

	# Źródło: paczka, z której uruchomiono skrypt; --ref; albo podpisany manifest.
	SRC_DIR="$(local_source)"
	local expected=""
	if [ "$FROM_REQUEST" -eq 0 ] && [ -n "$SRC_DIR" ] && [ "$SRC_DIR" != "$INSTALL_DIR/src" ]; then
		SRC_LABEL="$SRC_DIR"
	else
		SRC_DIR=""
		if [ "$REF_GIVEN" -eq 0 ]; then
			say "== Sprawdzam podpisany manifest wersji"
			manifest_target
			expected="$UPDATE_TARGET"
			SOURCE_REF="v$expected"
		fi
		SRC_LABEL="$(source_url)"
		if [ "$DRY_RUN" -eq 0 ]; then
			download_sources
			# download_sources ustawia własne sprzątanie — przywracamy pułapkę aktualizacji.
			trap update_trap EXIT
		fi
	fi
	if [ -n "$SRC_DIR" ]; then
		UPDATE_TO="$(app_version "$SRC_DIR")"
		[ -n "$UPDATE_TO" ] || die "Pobrany kod nie ma numeru wersji aplikacji."
		if [ -n "$expected" ] && [ "$UPDATE_TO" != "$expected" ]; then
			die "Pobrany kod ma wersję $UPDATE_TO, a manifest wskazuje $expected — przerwano."
		fi
		if [ "$UPDATE_FROM" != "nieznana" ] && version_lt "$UPDATE_TO" "$UPDATE_FROM"; then
			die "Wersja $UPDATE_TO jest starsza niż zainstalowana $UPDATE_FROM — obniżenie wersji nie jest obsługiwane (użyj restore kopii)."
		fi
	else
		UPDATE_TO="${expected:-$SOURCE_REF}"
	fi

	say "== Plan aktualizacji"
	say "- wersja: $UPDATE_FROM → $UPDATE_TO (źródło: $SRC_LABEL)"
	say "- miejsce: minimum ${MIN_DISK_MB} MB w /var/lib; przy braku najpierw usunięcie cache budowania Dockera"
	say "- kopia zapasowa pre-update w $(backup_dir)"
	say "- poprzedni kod w $INSTALL_DIR/src.previous i obrazy :previous (do powrotu)"
	say "- budowa obrazów, migracje bazy, uruchomienie i sprawdzenie gotowości"
	say "- przy błędzie: automatyczny powrót do $UPDATE_FROM (z odtworzeniem kopii, gdy zmieniła się baza)"
	say "- sprzątanie: starsze i osierocone obrazy aplikacji (etykieta $PRODUCT_LABEL), cache budowania starszy niż 7 dni; raport odzyskanego miejsca (D17, D73)"
	if [ "$DRY_RUN" -eq 1 ]; then
		say "== Tryb --dry-run: nic nie zmieniono."
		return 0
	fi
	confirm "Zaktualizować $PRODUCT z $UPDATE_FROM do $UPDATE_TO?" || die "Przerwano."
	ensure_update_disk

	say "== Kopia zapasowa"
	write_update_status RUNNING BACKUP
	compose up -d db
	wait_db
	UPDATE_BACKUP="$(make_backup pre-update)"
	say "Zapisano: $UPDATE_BACKUP"
	DB_REVISION_BEFORE="$(db_revision)"

	say "== Zachowuję poprzednią wersję"
	local image
	OLD_PREVIOUS_IMAGES=""
	for image in $APP_IMAGES; do
		if docker image inspect "$image:previous" >/dev/null 2>&1; then
			OLD_PREVIOUS_IMAGES="$OLD_PREVIOUS_IMAGES $(docker image inspect -f '{{.Id}}' "$image:previous")"
		fi
		if docker image inspect "$image:local" >/dev/null 2>&1; then
			docker image tag "$image:local" "$image:previous"
		fi
	done
	rm -rf "$INSTALL_DIR/src.previous" "$INSTALL_DIR/src.new"
	mkdir -p "$INSTALL_DIR/src.new"
	tar -C "$SRC_DIR" --exclude=./.git --exclude='*/node_modules' --exclude='./web/dist' --exclude='*/.venv' \
		--exclude='./deploy/.env' -cf - . | tar -C "$INSTALL_DIR/src.new" -xf -
	chmod 0755 "$INSTALL_DIR/src.new/deploy/install.sh"

	# Od tej chwili każde wyjście z błędem (die, set -e) przywraca poprzednią wersję (update_trap).
	mv "$INSTALL_DIR/src" "$INSTALL_DIR/src.previous"
	UPDATE_PHASE="switched"
	mv "$INSTALL_DIR/src.new" "$INSTALL_DIR/src"
	post_switch_hook

	say "== Budowa obrazów i uruchomienie"
	write_update_status RUNNING BUILD
	compose build
	write_update_status RUNNING START
	compose up -d --remove-orphans "${CORE_SERVICES[@]}"
	wait_healthy
	compose up -d agent
	if simulator_enabled; then
		compose up -d simulator
	fi
	UPDATE_PHASE="done"
	ln -sf "$INSTALL_DIR/src/deploy/install.sh" "$CLI_LINK"
	write_update_status RUNNING CLEANUP
	cleanup_after_update
	write_update_status SUCCESS DONE
	say ""
	say "Zaktualizowano $PRODUCT: $UPDATE_FROM → $UPDATE_TO. Kopia sprzed aktualizacji: $UPDATE_BACKUP"
}

# --- wejście ---------------------------------------------------------------------------------

main() {
	local command="${1:-}"
	[ $# -gt 0 ] && shift
	if [ "$command" = "simulator" ] && [ $# -gt 0 ] && [[ "$1" != -* ]]; then
		SIM_ACTION="$1"
		shift
	fi
	if [ "$command" = "restore" ] && [ $# -gt 0 ] && [[ "$1" != -* ]]; then
		RESTORE_FILE="$1"
		shift
	fi
	while [ $# -gt 0 ]; do
		case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--yes | -y) ASSUME_YES=1 ;;
		--purge) PURGE=1 ;;
		--auto) BACKUP_KIND="auto" ;;
		--from-request) FROM_REQUEST=1 ;;
		--no-auto-backup) AUTO_BACKUP=0 ;;
		--auto-backup) AUTO_BACKUP=1 ;;
		--no-update-check) UPDATE_CHECK=0 ;;
		--update-check) UPDATE_CHECK=1 ;;
		--to)
			[ $# -ge 2 ] || die "--to wymaga ścieżki."
			case "$2" in /*) ;; *) die "--to musi być ścieżką bezwzględną." ;; esac
			BACKUP_TO="${2%/}"
			shift
			;;
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
		--ref)
			[ $# -ge 2 ] || die "--ref wymaga nazwy gałęzi lub tagu."
			[[ "$2" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Nieprawidłowa nazwa --ref."
			SOURCE_REF="$2"
			REF_GIVEN=1
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
	if [ -z "$INSTALL_DIR" ] || [ "$INSTALL_DIR" = "/" ]; then
		die "Nieprawidłowy katalog instalacji."
	fi

	case "$command" in
	install) cmd_install ;;
	status) cmd_status ;;
	setup-link) cmd_setup_link ;;
	simulator) cmd_simulator ;;
	backup) cmd_backup ;;
	update) cmd_update ;;
	post-switch) cmd_post_switch ;;
	restore) cmd_restore ;;
	uninstall) cmd_uninstall ;;
	"" | -h | --help | help) usage ;;
	*) die "Nieznane polecenie: $command (zobacz --help)" ;;
	esac
}

main "$@"
