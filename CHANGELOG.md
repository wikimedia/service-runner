v5.0.0 / 2024-02-27
===================

* Release v5.0.0 (James D. Forrester)
* Bump various dependencies and devDependencies and drop support for node 14 (James D. Forrester)
* build: Upgrade eslint-config-wikimedia to 0.25.1 and simplify config (James D. Forrester)
* CI: Drop testing in Node 12 (#248) (James D. Forrester)

v4.0.0 / 2024-02-27
===================

* Require >= node12, update to 4.0.0 (James D. Forrester)
* Bump to yargs@16.2.0 (Arlo Breault)

v3.1.0 / 2021-12-20
===================

* Switch prometheus timings to seconds #2 (Alexandros Kosiaris)
* Revert "Switch prometheus timings to seconds" (Alexandros Kosiaris)
* Switch prometheus timings to seconds (Alexandros Kosiaris)
* Upgrade limitation to 0.2.3 (paladox)
* Remove gc-stats from package.json (Arlo Breault)

v3.0.0 / 2021-09-15
===================

* Drop Node 6 support and bump to 3.0.0 (#236) (James D. Forrester)

v2.9.0 / 2021-09-15
===================

* Remove GC stats feature (#240) (Petr Pchelko)

v2.8.4 / 2021-07-12
===================

* Release 2.8.4 (Petr Pchelko)
* Don't normalize prometheus label values (Ottomata)

v2.8.3 / 2021-05-06
===================

* Update package.json (Kosta Harlan)
* Bump limitation to 0.2.2 (Kosta Harlan)

v2.8.2 / 2021-04-01
===================

* Bugfix: clone labels when interpolating metric name (#235) (Cole White)

v2.8.1 / 2020-12-10
===================

* Update _handleStaticLabels (Clara Andrew-Wani)
* Fix object cloning (Clara Andrew-Wani)
* Fix label modifications in statsd and prometheus (Clara Andrew-Wani)

v2.8.0 / 2020-11-17
===================

* Move static label normalization to constructor (Clara Andrew-Wani)
* Fix histogram metrics (Clara Andrew-Wani)
* Normalize Prometheus metric name and label keys and values. Add env variable toggle to selectively disable service label. (Cole White)
* Update heapwatch metrics (Cole White)
* pass DEPRECATED_METHODS to LogClient so that legacy methods can be built fix bug where options.labels must now be an object with a names attribute for formatLabels to work correctly.  if undefined, instantiate at the metric level. update heapwatch Prometheus metrics to use more process-level naming for clarity. (Cole White)
* add staticLabels feature (Cole White)
* Attempt at a generic and backwards-compatible metrics interface. (Cole White)
* initial attempt at implementing native prometheus metrics (Cole White)
