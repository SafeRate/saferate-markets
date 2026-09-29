/**
 * The diagnostics of Tsay's Analysis of Financial Time Series (Wiley, 3rd ed.,
 * 2010) for a daily P&L series: is it fat-tailed, is its volatility
 * clustered, how heavy is the tail, and what does a Student-t say the tail
 * risk is. Alongside the GARCH(1,1) and extreme-value work already in
 * volatilityModels.ts, which is Tsay chapters 3 and 7; these are his chapter 1
 * and 2 tests and his t-innovation model.
 *
 *  - descriptive: skewness and EXCESS kurtosis (normal: 0), and Jarque-Bera
 *    for normality (Tsay 1.2).
 *  - Ljung-Box Q(m) on the series and on its SQUARES: squares autocorrelated
 *    means volatility clusters, the ARCH effect (Tsay 2.2, 3.3).
 *  - Hill's estimator of the tail index alpha from the largest losses:
 *    a smaller alpha is a heavier tail; a normal has none (alpha infinite).
 *  - a standardised Student-t fitted by maximum likelihood (Tsay 3.5), and
 *    VaR and expected shortfall from it.
 */

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export const describe = (xs: number[]) => {
	const n = xs.length;
	const m = mean(xs);
	const m2 = xs.reduce((s, x) => s + (x - m) ** 2, 0) / n;
	const m3 = xs.reduce((s, x) => s + (x - m) ** 3, 0) / n;
	const m4 = xs.reduce((s, x) => s + (x - m) ** 4, 0) / n;
	const skewness = m3 / m2 ** 1.5;
	const excessKurtosis = m4 / m2 ** 2 - 3;
	const jarqueBera = (n / 6) * (skewness ** 2 + excessKurtosis ** 2 / 4);
	return {
		n,
		mean: m,
		standardDeviation: Math.sqrt((m2 * n) / (n - 1)),
		skewness,
		excessKurtosis,
		jarqueBera,
		/** Chi-square with 2 degrees of freedom: exactly exp(-JB/2). */
		jarqueBeraPValue: Math.exp(-jarqueBera / 2),
	};
};

/* ─── The chi-square distribution, for p-values ──────────────────────────── */

const logGamma = (z: number): number => {
	// Lanczos, g = 7: good to about 15 digits for z > 0.
	const c = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028,
		771.32342877765313, -176.61502916214059, 12.507343278686905,
		-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	if (z < 0.5)
		return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
	const x = z - 1;
	let a = c[0];
	const t = x + 7.5;
	for (let i = 1; i < 9; i++) a += c[i] / (x + i);
	return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
};

/** Regularised lower incomplete gamma P(a, x): series below a + 1, continued fraction above. */
const gammaP = (a: number, x: number): number => {
	if (x <= 0) return 0;
	if (x < a + 1) {
		let term = 1 / a;
		let sum = term;
		for (let n = 1; n < 500; n++) {
			term *= x / (a + n);
			sum += term;
			if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
		}
		return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
	}
	let b = x + 1 - a;
	let c = 1e300;
	let d = 1 / b;
	let h = d;
	for (let i = 1; i < 500; i++) {
		const an = -i * (i - a);
		b += 2;
		d = an * d + b;
		if (Math.abs(d) < 1e-300) d = 1e-300;
		c = b + an / c;
		if (Math.abs(c) < 1e-300) c = 1e-300;
		d = 1 / d;
		const delta = d * c;
		h *= delta;
		if (Math.abs(delta - 1) < 1e-15) break;
	}
	return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
};

/** P(chi-square with k degrees of freedom > x). */
export const chiSquareSurvival = (x: number, k: number) =>
	1 - gammaP(k / 2, x / 2);

/* ─── Ljung-Box ──────────────────────────────────────────────────────────── */

/** Ljung-Box Q(m) and its p-value (chi-square, m degrees of freedom). */
export const ljungBox = (xs: number[], lags = 10) => {
	const n = xs.length;
	const m = mean(xs);
	const denominator = xs.reduce((s, x) => s + (x - m) ** 2, 0);
	let q = 0;
	const autocorrelations: number[] = [];
	for (let k = 1; k <= lags; k++) {
		let num = 0;
		for (let t = k; t < n; t++) num += (xs[t] - m) * (xs[t - k] - m);
		const rho = denominator > 0 ? num / denominator : 0;
		autocorrelations.push(rho);
		q += (rho * rho) / (n - k);
	}
	q *= n * (n + 2);
	return {
		lags,
		statistic: q,
		pValue: chiSquareSurvival(q, lags),
		autocorrelations,
	};
};

/* ─── Hill's tail index ──────────────────────────────────────────────────── */

/**
 * Hill's estimator of the tail index from the k largest LOSSES (the negated
 * left tail): 1 / mean(log(X_(i) / X_(k+1))). Default k is 2.5% of the
 * sample, the conventional compromise between bias (k too large reaches into
 * the body) and variance (k too small uses a handful of points).
 */
export const hillTailIndex = (xs: number[], fraction = 0.025) => {
	const losses = xs
		.filter((x) => x < 0)
		.map((x) => -x)
		.sort((a, b) => b - a);
	const k = Math.max(10, Math.floor(xs.length * fraction));
	if (losses.length <= k) return null;
	const threshold = losses[k];
	let sum = 0;
	for (let i = 0; i < k; i++) sum += Math.log(losses[i] / threshold);
	const alpha = k / sum;
	return {
		alpha,
		xi: 1 / alpha,
		k,
		threshold,
		standardError: alpha / Math.sqrt(k),
	};
};

/* ─── A standardised Student-t ───────────────────────────────────────────── */

/** Log density of a Student-t scaled to unit variance (nu > 2). */
const standardisedTLogDensity = (z: number, nu: number) => {
	const scale2 = (nu - 2) / nu;
	return (
		logGamma((nu + 1) / 2) -
		logGamma(nu / 2) -
		0.5 * Math.log(nu * Math.PI * scale2) -
		((nu + 1) / 2) * Math.log(1 + (z * z) / (nu * scale2))
	);
};

/**
 * Degrees of freedom of a unit-variance Student-t by maximum likelihood, on
 * standardised residuals (the GARCH-filtered series), by golden-section search
 * on log(nu - 2) over nu in (2.05, 200].
 */
export const fitStudentT = (standardised: number[]) => {
	const loglik = (nu: number) =>
		standardised.reduce((s, z) => s + standardisedTLogDensity(z, nu), 0);
	let lo = Math.log(0.05);
	let hi = Math.log(198);
	const phi = (Math.sqrt(5) - 1) / 2;
	let a = hi - phi * (hi - lo);
	let b = lo + phi * (hi - lo);
	let fa = loglik(2 + Math.exp(a));
	let fb = loglik(2 + Math.exp(b));
	for (let i = 0; i < 80; i++) {
		if (fa > fb) {
			hi = b;
			b = a;
			fb = fa;
			a = hi - phi * (hi - lo);
			fa = loglik(2 + Math.exp(a));
		} else {
			lo = a;
			a = b;
			fa = fb;
			b = lo + phi * (hi - lo);
			fb = loglik(2 + Math.exp(b));
		}
	}
	const nu = 2 + Math.exp((lo + hi) / 2);
	return { degreesOfFreedom: nu, logLikelihood: loglik(nu) };
};

/** Student-t CDF with nu degrees of freedom, via the regularised incomplete beta. */
const tCdf = (t: number, nu: number) => {
	const x = nu / (nu + t * t);
	const ib = regularisedBeta(x, nu / 2, 0.5);
	return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
};

const regularisedBeta = (x: number, a: number, b: number): number => {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const front = Math.exp(
		logGamma(a + b) -
			logGamma(a) -
			logGamma(b) +
			a * Math.log(x) +
			b * Math.log(1 - x),
	);
	if (x > (a + 1) / (a + b + 2)) return 1 - regularisedBeta(1 - x, b, a);
	// Lentz's continued fraction.
	let f = 1;
	let c = 1;
	let d = 1 - ((a + b) * x) / (a + 1);
	if (Math.abs(d) < 1e-300) d = 1e-300;
	d = 1 / d;
	f = d;
	for (let m = 1; m < 300; m++) {
		const m2 = 2 * m;
		let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < 1e-300) d = 1e-300;
		c = 1 + aa / c;
		if (Math.abs(c) < 1e-300) c = 1e-300;
		d = 1 / d;
		f *= d * c;
		aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
		d = 1 + aa * d;
		if (Math.abs(d) < 1e-300) d = 1e-300;
		c = 1 + aa / c;
		if (Math.abs(c) < 1e-300) c = 1e-300;
		d = 1 / d;
		const delta = d * c;
		f *= delta;
		if (Math.abs(delta - 1) < 1e-14) break;
	}
	return (front * f) / a;
};

/** The q-quantile of a Student-t (not standardised), by bisection on the CDF. */
export const tQuantile = (q: number, nu: number) => {
	let lo = -1e3;
	let hi = 1e3;
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2;
		if (tCdf(mid, nu) < q) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
};

/**
 * VaR and expected shortfall of a loss with volatility `sigma`, when
 * standardised returns are unit-variance Student-t with nu degrees of freedom.
 * ES for a t: the tail mean, (nu + x^2) / (nu - 1) * f(x) / p, rescaled.
 */
export const studentTRisk = (sigma: number, nu: number, confidence: number) => {
	const p = 1 - confidence;
	const x = tQuantile(p, nu); // negative
	const scale = Math.sqrt((nu - 2) / nu);
	const density = Math.exp(
		logGamma((nu + 1) / 2) -
			logGamma(nu / 2) -
			0.5 * Math.log(nu * Math.PI) -
			((nu + 1) / 2) * Math.log(1 + (x * x) / nu),
	);
	const tailMean = ((nu + x * x) / (nu - 1)) * (density / p);
	return {
		valueAtRisk: -x * scale * sigma,
		expectedShortfall: tailMean * scale * sigma,
	};
};
