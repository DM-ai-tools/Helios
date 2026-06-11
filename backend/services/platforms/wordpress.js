import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Deploys content to a WordPress site via the REST API.
 * Uses Application Passwords for authentication.
 * 
 * @param {Object} payload - The content payload to deploy
 * @param {Object} integration - The integration DB record
 */
export async function deployToWordPress(payload, integration) {
  // Use env var for ClickTrends testing, fallback to integration account name
  let siteUrl = process.env.WORDPRESS_SITE_URL || integration.account_name;
  siteUrl = siteUrl.replace(/\/$/, '').replace(/\/wp-admin$/, '');

  const username = process.env.WORDPRESS_USERNAME || integration.account_id;
  const password = process.env.WORDPRESS_PASSWORD || integration.access_token;
  
  if (!siteUrl || !username || !password) {
    throw new Error('Incomplete WordPress credentials. Ensure URL, Username, and Application Password are provided.');
  }

  if (!siteUrl.startsWith('http://') && !siteUrl.startsWith('https://')) {
    siteUrl = `https://${siteUrl}`;
  }
  
  // Basic Auth token
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  
  const axiosConfig = {
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  };

  try {
    // 1. Search for the page/post by Title (using payload.location or title)
    // The user answered "search by title"
    const searchQuery = payload.location || payload.title || 'Home';
    
    // Check pages first
    let searchEndpoint = `${siteUrl}/wp-json/wp/v2/pages?search=${encodeURIComponent(searchQuery)}&_fields=id,title,content,link`;
    let searchRes = await axios.get(searchEndpoint, axiosConfig);
    let targetObj = searchRes.data.length > 0 ? searchRes.data[0] : null;
    let objType = 'pages';

    // If not found in pages, check posts
    if (!targetObj) {
      searchEndpoint = `${siteUrl}/wp-json/wp/v2/posts?search=${encodeURIComponent(searchQuery)}&_fields=id,title,content,link`;
      searchRes = await axios.get(searchEndpoint, axiosConfig);
      targetObj = searchRes.data.length > 0 ? searchRes.data[0] : null;
      objType = 'posts';
    }

    if (!targetObj && payload.targetId) {
      targetObj = { id: payload.targetId }; // Fallback if explicitly provided
    }

    let endpoint = `${siteUrl}/wp-json/wp/v2/${objType}`;
    let method = 'POST';
    
    if (targetObj) {
      endpoint = `${siteUrl}/wp-json/wp/v2/${objType}/${targetObj.id}`;
    }

    // 2. Fetch/backup original content for rollback
    let originalContent = '';
    if (targetObj && targetObj.content) {
      originalContent = targetObj.content.raw || targetObj.content.rendered || '';
    }

    // 3. Deploy update
    const proposedText = payload.proposedChange || payload.content || '';
    
    const data = {
      title: payload.title,
      content: proposedText,
      status: 'publish'
    };

    const deployRes = await axios({
      method,
      url: endpoint,
      headers: axiosConfig.headers,
      data
    });

    const updatedObject = deployRes.data;
    const liveUrl = updatedObject.link;
    
    // 4. Verify live page
    let verified = false;
    let liveHtml = '';
    try {
      if (liveUrl && updatedObject.status !== 'draft') {
        const livePageRes = await axios.get(liveUrl);
        liveHtml = livePageRes.data;
        
        // Strip HTML from proposed text to do a soft match
        const $ = cheerio.load(liveHtml);
        const pageText = $('body').text().replace(/\s+/g, ' ');
        const strippedProposed = cheerio.load(proposedText).text().replace(/\s+/g, ' ');
        
        // If the live page contains our stripped text, or exact match
        if (pageText.includes(strippedProposed) || liveHtml.includes(proposedText)) {
          verified = true;
        }
      }
    } catch (vErr) {
      console.warn('Verification failed to fetch live URL:', vErr.message);
    }

    // Return extended diagnostics logs
    return {
      success: true,
      api_response: 'Successfully pushed to WordPress API',
      timestamp: new Date().toISOString(),
      platform_resource_id: updatedObject.id.toString(),
      live_url: liveUrl,
      targetTitle: updatedObject.title?.rendered || payload.title,
      
      // Rollback payload (save the old state)
      previous_content: {
        title: targetObj ? targetObj.title.rendered : payload.title,
        content: originalContent,
        targetId: updatedObject.id
      },
      
      // Diagnostics 
      response_payload: {
        verified,
        platform_resource_id: updatedObject.id.toString(),
        live_url: liveUrl,
        timestamp: new Date().toISOString(),
        targetTitle: updatedObject.title?.rendered || payload.title,
        contentSent: proposedText,
        htmlFetched: !!liveHtml
      }
    };

  } catch (error) {
    let errorMessage = error.message;
    if (error.response) {
      errorMessage = `WordPress API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`;
    }
    throw new Error(errorMessage);
  }
}
