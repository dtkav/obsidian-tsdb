/**
 * Typings for prom-client deep imports. The package's CommonJS index
 * eagerly requires its Pushgateway (and with it Node's url/request
 * machinery), so we import the metric classes from their submodules and
 * the index never enters the bundle. prom-client only ships types for the
 * package root; these declarations map each submodule onto those types.
 */

declare module "prom-client/lib/registry" {
	import { Registry } from "prom-client";
	export = Registry;
}

declare module "prom-client/lib/counter" {
	import { Counter } from "prom-client";
	export = Counter;
}

declare module "prom-client/lib/gauge" {
	import { Gauge } from "prom-client";
	export = Gauge;
}

declare module "prom-client/lib/histogram" {
	import { Histogram } from "prom-client";
	export = Histogram;
}

declare module "prom-client/lib/summary" {
	import { Summary } from "prom-client";
	export = Summary;
}
