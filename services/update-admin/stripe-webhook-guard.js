function isKeptraLicenseCheckout(metadata) {
  return metadata?.checkout_source === 'keptra-license';
}

module.exports = { isKeptraLicenseCheckout };
