export class WordPressAdapter {
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

  async deploy(params) {
    const {
      payload,
      targetObj,
      actionType,
      endpoint,
      method,
      targetSlug,
      parentId,
      objType
    } = params;

    let proposedText = payload.html || payload.proposedChange || payload.content || '';
    proposedText = this.encode4ByteCharsToEntities(proposedText);
    
    const isMetadata = payload.changeType === 'metadata';
    const requestData = { status: 'publish' };

    if (!targetObj || actionType === 'create_page') {
      requestData.title = this.encode4ByteCharsToEntities(payload.pageTitle || payload.title || 'Untitled Page');
      requestData.slug = targetSlug || undefined;
    }

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
      const gutenbergWrappedContent = `<!-- wp:html -->\n${proposedText}\n<!-- /wp:html -->`;
      let finalContent = gutenbergWrappedContent;

      if (targetObj && actionType !== 'create_page') {
        const origContent = targetObj.content?.raw || targetObj.content?.rendered || '';
        const search = payload.currentState || '';
        if (origContent && search) {
          if (actionType === 'replace') {
            finalContent = origContent.replace(search, gutenbergWrappedContent);
          } else if (actionType === 'insert_after') {
            finalContent = origContent.replace(search, search + '\n' + gutenbergWrappedContent);
          } else if (actionType === 'insert_before') {
            finalContent = origContent.replace(search, gutenbergWrappedContent + '\n' + search);
          }
          if (!origContent.includes(search)) {
            finalContent = origContent + '\n' + gutenbergWrappedContent;
          }
        } else if (origContent && !search) {
          finalContent = origContent + '\n' + gutenbergWrappedContent;
        }
      }
      requestData.content = finalContent;
    }

    if (objType === 'pages') {
      if (parentId !== undefined) {
        requestData.parent = parentId;
      }
      if (payload.navigationParent) {
        requestData.template = 'elementor_canvas';
      }
      if (actionType === 'create_page') {
        if (payload.builderType === 'elementor' && payload.generatedElementorData) {
          requestData.meta = {
            ...(requestData.meta || {}),
            _elementor_edit_mode: 'builder',
            _elementor_template_type: 'wp-page',
            _wp_page_template: 'elementor_header_footer'
          };
          // The Elementor data can either be sent in the meta object if the REST API supports it
          // OR it might need to be sent differently depending on the specific endpoint being used.
          // Since the prompt states: "update all required Elementor metadata before publishing"
          // We will include it in the meta object.
          requestData.meta._elementor_data = JSON.stringify(payload.generatedElementorData);
        } else {
          requestData.meta = {
            ...(requestData.meta || {}),
            _elementor_edit_mode: 'default'
          };
        }
      }
    }

    const deployRes = await this.axios({
      method,
      url: endpoint,
      data: requestData
    });

    return {
      updatedObject: deployRes.data,
      method: 'native_wordpress'
    };
  }
}
