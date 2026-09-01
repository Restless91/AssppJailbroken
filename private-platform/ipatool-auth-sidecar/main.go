package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/byteness/keyring"
	cookiejar "github.com/juju/persistent-cookiejar"
	"github.com/majd/ipatool/v2/pkg/appstore"
	ipakeychain "github.com/majd/ipatool/v2/pkg/keychain"
	"github.com/majd/ipatool/v2/pkg/util/machine"
	"github.com/majd/ipatool/v2/pkg/util/operatingsystem"
)

var loginMu sync.Mutex

type loginRequest struct{ Email, Password, AuthCode string }

func main() {
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "service": "ipatool-sap"})
	})
	http.HandleFunc("/auth/login", handleLogin)
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8787"
	}
	if err := http.ListenAndServe(addr, nil); err != nil {
		panic(err)
	}
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	var input loginRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&input); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid JSON"})
		return
	}
	if input.Email == "" || input.Password == "" {
		writeJSON(w, 400, map[string]string{"error": "email and password are required"})
		return
	}
	loginMu.Lock()
	defer loginMu.Unlock()
	store, err := newAppStore()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	result, err := store.Login(appstore.LoginInput{Email: input.Email, Password: input.Password, AuthCode: input.AuthCode})
	if err != nil {
		if errors.Is(err, appstore.ErrAuthCodeRequired) {
			writeJSON(w, 409, map[string]any{"codeRequired": true, "error": "Apple ID 需要二次验证码"})
			return
		}
		writeJSON(w, 502, map[string]string{"error": err.Error()})
		return
	}
	acc := result.Account
	// Never expose the password; the platform only needs the reusable token.
	writeJSON(w, 200, map[string]any{"account": map[string]string{
		"email": acc.Email, "passwordToken": acc.PasswordToken,
		"directoryServicesIdentifier": acc.DirectoryServicesID,
		"storeFront":                  acc.StoreFront, "pod": acc.Pod,
	}})
}

func newAppStore() (appstore.AppStore, error) {
	home := os.Getenv("HOME")
	if home == "" {
		home = "/data"
	}
	os.Setenv("HOME", home)
	_ = os.MkdirAll(filepath.Join(home, ".ipatool"), 0700)
	passphrase := os.Getenv("IPATOOL_KEYCHAIN_PASSPHRASE")
	if passphrase == "" {
		return nil, errors.New("IPATOOL_KEYCHAIN_PASSPHRASE is required")
	}
	ring, err := keyring.Open(keyring.Config{AllowedBackends: []keyring.BackendType{keyring.FileBackend}, ServiceName: "ipatool", FileDir: filepath.Join(home, ".ipatool"), FilePasswordFunc: func(string) (string, error) { return passphrase, nil }})
	if err != nil {
		return nil, err
	}
	osys := operatingsystem.New()
	mach := machine.New(machine.Args{OS: osys})
	jar, err := cookiejar.New(&cookiejar.Options{Filename: filepath.Join(home, ".ipatool", "cookies.jar")})
	if err != nil {
		return nil, err
	}
	return appstore.NewAppStore(appstore.Args{Keychain: ipakeychain.New(ipakeychain.Args{Keyring: ring, Label: "ipatool"}), CookieJar: jar, OperatingSystem: osys, Machine: mach}), nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
