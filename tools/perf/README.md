# Pomiary wydajności

`measure.sh` mierzy serwer: CPU i pamięć procesów, zapis na dysk, czasy HTTP. Z `sudo` mierzy też
kontenery, logi Dockera, bufor agenta, rozmiary tabel i czasy kluczowych zapytań SQL
(`EXPLAIN ANALYZE` w transakcji READ ONLY). Skrypt niczego nie zmienia.

```bash
sudo bash measure.sh 120 > wynik.txt
```

Wyniki bazowe (przed optymalizacją) są w `wyniki/`. Po zmianach zmierz tak samo i porównaj
`diff` albo obok siebie. Porównuj tylko pomiary z tego samego serwera, z tym samym oknem i przy
podobnej liczbie urządzeń.
