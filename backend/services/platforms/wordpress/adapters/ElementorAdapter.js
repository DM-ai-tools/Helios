export class ElementorAdapter {
  constructor(axiosInstance) {
    this.axios = axiosInstance;
  }

  encode4ByteCharsToEntities(str) {
    if (!str) return str;
    return str.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, (match) => {
      const high = match.charCodeAt(0);
      const low = match.charCodeAt(1);
      const codePoint = ((high - 0xD800) * 0x400) + (low - 0xDC00) + 0x10000;
      return `&#${codePoint};`;
    });
  }

  recursiveReplace(element, search, replaceStr, actionType) {
    let replaced = false;
    if (!element) return replaced;

    if (element.settings) {
      for (const [key, value] of Object.entries(element.settings)) {
        if (typeof value === 'string' && value.includes(search)) {
          // Replace it
          if (actionType === 'replace') {
            element.settings[key] = value.replace(search, replaceStr);
          } else if (actionType === 'insert_after') {
            element.settings[key] = value.replace(search, search + ' ' + replaceStr);
          } else if (actionType === 'insert_before') {
            element.settings[key] = value.replace(search, replaceStr + ' ' + search);
          }
          replaced = true;
        }
      }
    }

    if (element.elements && Array.isArray(element.elements)) {
      for (let i = 0; i < element.elements.length; i++) {
        if (this.recursiveReplace(element.elements[i], search, replaceStr, actionType)) {
          replaced = true;
        }
      }
    }

    return replaced;
  }

  async deploy(params) {
    const {
      payload,
      targetObj,
      actionType,
      endpoint,
      method
    } = params;

    let proposedText = payload.html || payload.proposedChange || payload.content || '';
    proposedText = this.encode4ByteCharsToEntities(proposedText);

    const isMetadata = payload.changeType === 'metadata';
    const requestData = { meta: {} };

    let elementorUpdated = false;

    if (isMetadata) {
      const isTitle = (
        (payload.description && payload.description.toLowerCase().includes('title')) ||
        (payload.title && payload.title.toLowerCase().includes('title')) ||
        (payload.currentState && payload.currentState.toLowerCase().includes('title'))
      );
      if (isTitle) {
        requestData.title = proposedText;
      } else {
        requestData.excerpt = proposedText;
      }
    } else {
      let elementorDataStr = targetObj.meta?._elementor_data;
      if (elementorDataStr) {
        try {
          let elementorData = JSON.parse(elementorDataStr);
          const search = payload.currentState || '';
          if (search) {
            let replaced = false;
            for (let i = 0; i < elementorData.length; i++) {
              if (this.recursiveReplace(elementorData[i], search, proposedText, actionType)) {
                replaced = true;
              }
            }
            if (replaced) {
              requestData.meta._elementor_data = JSON.stringify(elementorData);
              elementorUpdated = true;
            } else {
              throw new Error("Search text not found in Elementor widget settings.");
            }
          } else {
            throw new Error("No search text provided for Elementor update.");
          }
        } catch (err) {
          console.warn(`[ElementorAdapter] JSON manipulation failed: ${err.message}. Falling back to native WordPress content append.`);
          requestData.content = (targetObj.content?.raw || '') + `\n<!-- wp:html -->\n${proposedText}\n<!-- /wp:html -->`;
        }
      } else {
        requestData.content = (targetObj.content?.raw || '') + `\n<!-- wp:html -->\n${proposedText}\n<!-- /wp:html -->`;
      }
    }

    const deployRes = await this.axios({
      method,
      url: endpoint,
      data: requestData
    });

    return {
      updatedObject: deployRes.data,
      method: elementorUpdated ? 'elementor_native_json' : 'native_wordpress_fallback'
    };
  }
}
